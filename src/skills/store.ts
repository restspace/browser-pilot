import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocatorCandidate } from '../daemon/recorder.js';
import { rootDir } from '../shared/paths.js';

/**
 * A stored, parameterised procedure: what one successful `do` instruction did,
 * in a form that can be replayed on a later run of the same app without the
 * model. Keyed by origin, not session, because the point is that run N+1
 * benefits from run N.
 */
export interface Skill {
  id: string;
  origin: string;
  /** The instruction with its literal values replaced by {{vN}} slots. */
  template: string;
  params: Record<string, SkillParam>;
  preconditions: { urlPattern: string; fingerprint?: number[] };
  steps: SkillStep[];
  /** The report the original run produced, with slots, for the zero-LLM path. */
  reportTemplate?: { summary: string; values: Record<string, string> };
  stats: SkillStats;
  status: SkillStatus;
  /** Set on a skill compiled from a replay-then-repair of another skill. */
  variantOf?: string;
  provenance: { session: string; instruction: string; model?: string; created: string };
}

export interface SkillParam {
  /** The value this slot had on the run that created the skill. */
  example: string;
  /** 1-based indices of the steps that use this slot. */
  usedIn: number[];
}

export interface SkillStep {
  tool: string;
  /** Tool arguments with slot values substituted as "{{vN}}" in string fields. */
  args: Record<string, unknown>;
  /** Ways of finding each target, best first; strings inside may carry slots. */
  locators: Record<string, LocatorCandidate[]>;
  expect?: StepExpectation;
  /** For read/read_all steps: which report value this read supplied, if any. */
  label?: string;
  /** Step-level provenance: executed by replay of another skill, or chosen by the agent. */
  via?: { skill: string; step: number };
}

export interface StepExpectation {
  /** Hard: the normalised url after the step must match. Present only when the step changed the url. */
  urlPattern?: string;
  /** Soft: an alert containing this text appeared. */
  alertContains?: string;
  /** Soft: page lines that appeared after the step. */
  addedContains?: string[];
}

export interface SkillStats {
  uses: number;
  successes: number;
  /** Replays that stopped part-way (the agent may still have completed the instruction). */
  partial: number;
  created: string;
  lastUsed?: string;
  /** 1-based step index → how often replay failed there. */
  failedAtStep: Record<string, number>;
  lastFailedAt?: number;
  /** How often a fallback locator (not the recorded primary) had to be used — drift signal. */
  fallthroughs: number;
}

export type SkillStatus = 'provisional' | 'validated' | 'demoted';

export interface ReplayOutcome {
  ok: boolean;
  /** 1-based index of the step that failed, when !ok. */
  failedAt?: number;
  fallthroughs?: number;
  /** Whether the instruction around the replay ended in a successful report. */
  instructionSucceeded: boolean;
}

/** Where skills live: `$BROWSER_PILOT_SKILLS_DIR` or `<home>/skills`. */
export function skillsDir(): string {
  return process.env.BROWSER_PILOT_SKILLS_DIR || path.join(rootDir(), 'skills');
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return u.protocol === 'file:' ? 'file://' : null;
    return u.origin;
  } catch {
    return null;
  }
}

export function originSlug(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_') || 'file';
}

/**
 * One JSON file per origin. Reads are fresh on every access so several
 * daemons (one per session) sharing a store see each other's skills; writes
 * are whole-file, which is fine at the tens-of-skills scale this is for.
 */
export class SkillStore {
  constructor(readonly dir: string = skillsDir()) {}

  private file(origin: string): string {
    return path.join(this.dir, `${originSlug(origin)}.json`);
  }

  origins(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      const skills = this.read(path.join(this.dir, n));
      if (skills[0]) out.push(skills[0].origin);
    }
    return out;
  }

  private read(file: string): Skill[] {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(raw) ? (raw as Skill[]) : [];
    } catch {
      return [];
    }
  }

  private write(origin: string, skills: Skill[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(origin);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(skills, null, 1));
    fs.renameSync(tmp, file);
  }

  list(origin: string): Skill[] {
    return this.read(this.file(origin));
  }

  all(): Skill[] {
    return this.origins().flatMap((o) => this.list(o));
  }

  get(id: string): Skill | null {
    return this.all().find((s) => s.id === id) ?? null;
  }

  put(skill: Skill): void {
    const skills = this.list(skill.origin).filter((s) => s.id !== skill.id);
    skills.push(skill);
    this.write(skill.origin, skills);
  }

  remove(id: string): boolean {
    const skill = this.get(id);
    if (!skill) return false;
    this.write(skill.origin, this.list(skill.origin).filter((s) => s.id !== id));
    return true;
  }

  clear(origin: string): number {
    const n = this.list(origin).length;
    try {
      fs.rmSync(this.file(origin), { force: true });
    } catch {
      // best effort
    }
    return n;
  }

  /**
   * Fold a replay's outcome into the skill's stats and status.
   *
   * Promotion: provisional → validated on the second clean end-to-end replay
   * inside a successful instruction. Demotion: the same step failing twice in
   * a row. One success is evidence, not proof (the bench caught a fabricated
   * "success" once); one failure can be a flaky page.
   */
  recordOutcome(id: string, outcome: ReplayOutcome, now = new Date().toISOString()): Skill | null {
    const skill = this.get(id);
    if (!skill) return null;
    const st = skill.stats;
    st.uses += 1;
    st.lastUsed = now;
    st.fallthroughs += outcome.fallthroughs ?? 0;
    if (outcome.ok && outcome.instructionSucceeded) {
      st.successes += 1;
      st.lastFailedAt = undefined;
      if (skill.status === 'provisional' && st.successes >= 2) skill.status = 'validated';
    } else if (!outcome.ok) {
      st.partial += 1;
      const at = outcome.failedAt ?? 0;
      st.failedAtStep[String(at)] = (st.failedAtStep[String(at)] ?? 0) + 1;
      if (st.lastFailedAt === at) skill.status = 'demoted';
      st.lastFailedAt = at;
    }
    this.put(skill);
    return skill;
  }

  /** A validated variant supersedes the skill it repaired. */
  supersede(originalId: string): void {
    const original = this.get(originalId);
    if (!original || original.status === 'demoted') return;
    original.status = 'demoted';
    this.put(original);
  }
}

export function newSkillId(origin: string, template: string, created: string): string {
  return 's_' + crypto.createHash('sha1').update(`${origin}\n${template}\n${created}`).digest('hex').slice(0, 6);
}

export function successRate(s: Skill): number {
  return s.stats.uses ? s.stats.successes / s.stats.uses : 0;
}
