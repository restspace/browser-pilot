// Repair Desk - single page front end.
//
// Plain ES module, no framework, no build step. The application shell lives in
// index.html; this module owns routing, data fetching and the rendering of the
// three views (login, ticket list, ticket detail).
//
// Two conventions run through the whole file:
//
//  1. Every value that originated with a user (ticket titles, customer names,
//     part names, supplier names, and any error sentence the server sends) is
//     passed through esc() before it reaches an innerHTML assignment. This is a
//     local test app, but an XSS is still an XSS.
//  2. Every non-2xx response is surfaced as visible text. The shared error
//     region is the single place a human (or an agent) can read why the server
//     said no, including the `unmet` list on a 409.

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIST_DELAY_MS = 600;
const PAGE_SIZE = 10; // mirrors the server; used only for the "showing N of M" hint

const STATUSES = ['Draft', 'Ready', 'Closed'];

// Legal transitions, per the spec: Draft -> Ready, Ready -> Draft,
// Ready -> Closed. Closed is terminal, so it offers no buttons at all.
const TRANSITIONS = {
  Draft: ['Ready'],
  Ready: ['Draft', 'Closed'],
  Closed: []
};

const $ = (sel, root = document) => root.querySelector(sel);

/** Escape text for interpolation into HTML, including into quoted attributes. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Money is rendered from the server's number, never recomputed here. The spec
 * is explicit that `price` is derived server-side; the front end's only job is
 * to print it with exactly two decimals.
 */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toFixed(2);
}

/**
 * Dates are shown as a plain UTC calendar date. Deliberately not "2 hours ago"
 * and deliberately not locale- or timezone-dependent: the same seed must
 * produce the same visible text on every machine that runs the benchmark.
 */
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The deliberate list-refresh delay
// ---------------------------------------------------------------------------
//
// After a create or a delete the affected view refetches after a delay rather
// than immediately. Real SPAs do this (close optimistically, then revalidate)
// and the benchmark task depends on it, so it is not removable and not exposed
// in the UI. It is configurable two ways only: the `listDelayMs` query param on
// the page URL, and window.__LIST_DELAY_MS for a harness that wants to set it
// after load. The value is read at each use, so a late assignment still wins.

(function initListDelay() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('listDelayMs')) {
    const parsed = Number(params.get('listDelayMs'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      window.__LIST_DELAY_MS = parsed;
      return;
    }
  }
  if (typeof window.__LIST_DELAY_MS !== 'number') {
    window.__LIST_DELAY_MS = DEFAULT_LIST_DELAY_MS;
  }
})();

function listDelay() {
  const v = Number(window.__LIST_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_LIST_DELAY_MS;
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  user: null,
  // Ticket list filters. Held here rather than read back out of the DOM so that
  // a repaint of the table can never lose them.
  list: { status: 'all', q: '', archived: false, page: 1 },
  // Whatever the detail view is currently showing. The delegated click handler
  // reads this, which is what lets the handler be attached exactly once.
  detail: null,
  listSeq: 0,  // guards against a stale list response painting over a newer one
  routeSeq: 0, // ditto for a slow route that has been superseded
  refreshTimer: null
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Thin fetch wrapper. Always resolves - transport failures come back shaped
 * like a server error, so every caller has exactly one error path to render.
 */
async function api(method, path, body) {
  const options = {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin'
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server: ' + err.message } };
  }

  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // A non-JSON body is still information worth showing the user.
        data = { error: text };
      }
    }
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Error rendering
// ---------------------------------------------------------------------------

const errorRegion = () => $('#error-region');

function clearError() {
  const el = errorRegion();
  el.innerHTML = '';
  el.classList.remove('is-shown');
}

/**
 * Turn an error payload into visible markup.
 *
 * A 409 from the Ready precondition carries `{ error, unmet: [...] }`, and the
 * unmet lines are the whole point - they are how the business rule is
 * discovered. They are rendered as a real <ul>; nothing here is logged and
 * dropped.
 */
function errorHtml(payload, status) {
  const sentence = payload && payload.error
    ? String(payload.error)
    : 'The server rejected the request' + (status ? ' (HTTP ' + status + ')' : '') + '.';

  let html = '<p class="error-title" data-testid="error-message">' + esc(sentence) + '</p>';

  if (payload && Array.isArray(payload.unmet) && payload.unmet.length > 0) {
    html += '<ul class="error-list" data-testid="error-unmet">';
    for (const line of payload.unmet) {
      html += '<li>' + esc(line) + '</li>';
    }
    html += '</ul>';
  }
  return html;
}

function showError(payload, status) {
  const el = errorRegion();
  el.innerHTML = errorHtml(payload, status);
  el.classList.add('is-shown');
}

function showErrorText(message) {
  showError({ error: message });
}

/**
 * Handle a failed API response uniformly.
 *
 * A 401 anywhere other than the login form means the session has gone away, so
 * we bounce to the login view - but the server's own sentence is rendered first
 * so the reason stays readable.
 */
function handleFailure(result) {
  showError(result.data, result.status);
  if (result.status === 401) {
    state.user = null;
    updateNav();
    if (currentRoute().name !== 'login') {
      window.location.hash = '#/login';
    }
  }
}

// ---------------------------------------------------------------------------
// The "Refreshing..." indicator
// ---------------------------------------------------------------------------
//
// The element is added to the DOM only while a refetch is pending and removed
// afterwards, rather than being left in place and toggled with `hidden`.
// Appearing and then disappearing is the least ambiguous signal for an
// automated client that is waiting for the view to settle.

function showRefreshing() {
  const region = $('#status-region');
  if (region.querySelector('[data-testid="refreshing"]')) return;
  const el = document.createElement('p');
  el.className = 'refreshing';
  el.setAttribute('data-testid', 'refreshing');
  el.textContent = 'Refreshing…';
  region.appendChild(el);
}

function hideRefreshing() {
  const el = $('#status-region [data-testid="refreshing"]');
  if (el) el.remove();
}

/**
 * Run `fn` after the configured delay with the indicator visible throughout.
 * Used after creates and deletes only; edits and status changes repaint
 * immediately, because the spec scopes the delay to create and delete.
 */
function scheduleRefresh(fn) {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  showRefreshing();
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    try {
      await fn();
    } finally {
      hideRefreshing();
    }
  }, listDelay());
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
//
// <dialog>.showModal() supplies the backdrop, the focus trap and
// Escape-to-close. What it does not do is choose the initially focused control
// or put focus back where it came from, so we do both by hand.

let formDialogSubmit = null; // submit handler for the currently open form dialog
let lastFocused = null;      // element to restore focus to when a dialog closes

function fieldMarkup(field) {
  const id = 'f-' + field.name;
  const help = field.help
    ? '<p class="field-help" id="' + esc(id) + '-help">' + esc(field.help) + '</p>'
    : '';
  const describedBy = field.help ? ' aria-describedby="' + esc(id) + '-help"' : '';
  const attrs = [
    'id="' + esc(id) + '"',
    'name="' + esc(field.name) + '"',
    'data-testid="field-' + esc(field.name) + '"',
    'class="input"',
    'type="' + esc(field.type || 'text') + '"',
    'value="' + esc(field.value === null || field.value === undefined ? '' : field.value) + '"'
  ];
  if (field.step) attrs.push('step="' + esc(field.step) + '"');
  if (field.min !== undefined) attrs.push('min="' + esc(field.min) + '"');
  if (field.required) attrs.push('required');
  if (field.placeholder) attrs.push('placeholder="' + esc(field.placeholder) + '"');

  return (
    '<div class="field">' +
      '<label class="field-label" for="' + esc(id) + '">' + esc(field.label) +
        (field.required ? ' <span class="field-required" aria-hidden="true">*</span>' : '') +
      '</label>' +
      '<input ' + attrs.join(' ') + describedBy + '>' +
      help +
    '</div>'
  );
}

/**
 * Open the shared form dialog.
 *
 * `onSubmit(values)` returns a truthy value to close the dialog, or a falsy one
 * to keep it open - which is what happens when the server rejects the save and
 * the user needs to correct a field.
 */
function openFormDialog({ title, description, fields, saveLabel, onSubmit }) {
  const dialog = $('#form-dialog');
  lastFocused = document.activeElement;

  $('#form-dialog-title').textContent = title;
  const descEl = $('#form-dialog-desc');
  descEl.textContent = description || '';
  descEl.hidden = !description;

  $('#dialog-fields').innerHTML = fields.map(fieldMarkup).join('');
  $('#dialog-error').innerHTML = '';
  $('#modal-save').textContent = saveLabel || 'Save';

  formDialogSubmit = onSubmit;
  dialog.showModal();

  // Focus the first field rather than the first focusable element, which would
  // otherwise be the Cancel button.
  const first = $('#dialog-fields input');
  if (first) {
    first.focus();
    first.select();
  }
}

function closeFormDialog() {
  const dialog = $('#form-dialog');
  if (dialog.open) dialog.close();
}

function readDialogValues() {
  const values = {};
  for (const input of $('#dialog-fields').querySelectorAll('input')) {
    values[input.name] = input.value;
  }
  return values;
}

/**
 * Show a save failure in two places on purpose. A modal <dialog> renders the
 * rest of the document inert, so an error placed only in the shared region
 * would be unreadable while the dialog is open - but the shared region is also
 * the documented place to look, so it gets a copy for after the dialog closes.
 */
function showDialogError(payload, status) {
  $('#dialog-error').innerHTML = errorHtml(payload, status);
  showError(payload, status);
}

function openConfirm({ message, confirmLabel }) {
  const dialog = $('#confirm-dialog');
  const yes = $('#confirm-yes');
  const no = $('#confirm-no');

  lastFocused = document.activeElement;
  $('#confirm-message').textContent = message;
  yes.textContent = confirmLabel || 'Confirm';
  dialog.showModal();
  no.focus(); // safest default for a destructive confirm

  return new Promise((resolve) => {
    const finish = (answer) => {
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(answer);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    const onClose = () => finish(false); // covers Escape and the backdrop
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    dialog.addEventListener('close', onClose);
  });
}

function wireDialogs() {
  const formDialog = $('#form-dialog');

  $('#dialog-form').addEventListener('submit', async (event) => {
    event.preventDefault(); // we close the dialog ourselves, and only on success
    if (!formDialogSubmit) return;
    const save = $('#modal-save');
    const handler = formDialogSubmit;
    save.disabled = true;
    try {
      const ok = await handler(readDialogValues());
      if (ok) closeFormDialog();
    } finally {
      save.disabled = false;
    }
  });

  $('#modal-cancel').addEventListener('click', () => closeFormDialog());

  // Fires for Cancel and for Escape alike, so restoring focus here covers every
  // way the dialog can be dismissed.
  formDialog.addEventListener('close', () => {
    formDialogSubmit = null;
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  });

  $('#confirm-dialog').addEventListener('close', () => {
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  });
}

// ---------------------------------------------------------------------------
// Navigation chrome
// ---------------------------------------------------------------------------

function updateNav() {
  const nav = $('#nav');
  nav.hidden = !state.user;
  $('#nav-user-name').textContent = state.user ? state.user.name : '';
}

function wireNav() {
  $('#sign-out').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    state.user = null;
    updateNav();
    clearError();
    window.location.hash = '#/login';
  });
}

// ---------------------------------------------------------------------------
// View: login
// ---------------------------------------------------------------------------

function renderLogin() {
  state.detail = null;
  updateNav();

  $('#view').innerHTML =
    '<div class="login-wrap">' +
      '<section class="card login-card" aria-labelledby="login-heading">' +
        '<header class="card-head">' +
          '<h1 id="login-heading" class="card-title">Sign in to Repair Desk</h1>' +
          '<p class="card-subtitle">Use your workshop account to view and update repair tickets.</p>' +
        '</header>' +
        '<form id="login-form" class="card-body" novalidate>' +
          '<div class="field">' +
            '<label class="field-label" for="login-email">Email address</label>' +
            '<input class="input" id="login-email" data-testid="login-email" name="email" type="email" ' +
              'autocomplete="username" aria-describedby="login-email-help" required>' +
            '<p class="field-help" id="login-email-help">The address your workshop account was created with.</p>' +
          '</div>' +
          '<div class="field">' +
            '<label class="field-label" for="login-password">Password</label>' +
            '<input class="input" id="login-password" data-testid="login-password" name="password" ' +
              'type="password" autocomplete="current-password" required>' +
          '</div>' +
          '<div class="form-actions">' +
            '<button type="submit" class="btn btn-primary" data-testid="login-submit">Sign in</button>' +
          '</div>' +
        '</form>' +
      '</section>' +
    '</div>';

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;

    const result = await api('POST', '/api/login', { email, password });
    if (!result.ok) {
      // SPEC-GAP: the spec fixes the wording shown on a 401 here ("Email or
      // password is not recognised"), which need not match the sentence the
      // server sends. The fixed wording wins for 401; every other status
      // renders the server's own message.
      if (result.status === 401) {
        showErrorText('Email or password is not recognised');
      } else {
        showError(result.data, result.status);
      }
      $('#login-password').value = '';
      $('#login-password').focus();
      return;
    }

    state.user = result.data && result.data.user ? result.data.user : null;
    updateNav();
    window.location.hash = '#/tickets';
  });

  $('#login-email').focus();
}

// ---------------------------------------------------------------------------
// View: ticket list
// ---------------------------------------------------------------------------
//
// The list renders in two stages. The shell (page header, filter row, empty
// table) is built once when the route is entered, and refreshList() repaints
// only the tbody, the summary and the pagination footer. That keeps focus and
// caret position inside the search box while typing, which a full re-render of
// the view would destroy on every keystroke.

function renderListShell() {
  const l = state.list;
  const statusOptions = ['all', ...STATUSES]
    .map((s) => {
      const label = s === 'all' ? 'All statuses' : s;
      const selected = l.status === s ? ' selected' : '';
      return '<option value="' + esc(s) + '"' + selected + '>' + esc(label) + '</option>';
    })
    .join('');

  $('#view').innerHTML =
    '<div class="page-head">' +
      '<div class="page-head-text">' +
        '<h1 class="page-title">Repair tickets</h1>' +
        '<p class="page-subtitle">Every job on the bench, newest first. Open a ticket to manage its parts.</p>' +
      '</div>' +
      '<div class="page-head-actions">' +
        '<button type="button" class="btn btn-primary" data-testid="new-ticket">New ticket</button>' +
      '</div>' +
    '</div>' +

    '<section class="card" aria-labelledby="filters-heading">' +
      '<h2 id="filters-heading" class="visually-hidden">Filter tickets</h2>' +
      '<div class="filter-row">' +
        '<div class="field field-inline">' +
          '<label class="field-label" for="status-filter">Status</label>' +
          '<select class="input" id="status-filter" data-testid="status-filter">' + statusOptions + '</select>' +
        '</div>' +
        '<div class="field field-inline field-grow">' +
          '<label class="field-label" for="search">Search</label>' +
          '<input class="input" id="search" data-testid="search" type="search" ' +
            'placeholder="Reference, title or customer" aria-describedby="search-help" value="' + esc(l.q) + '">' +
          '<p class="field-help" id="search-help">Matches the reference, the title and the customer name.</p>' +
        '</div>' +
        '<div class="field field-inline field-check">' +
          '<input class="checkbox" id="show-archived" data-testid="show-archived" type="checkbox"' +
            (l.archived ? ' checked' : '') + '>' +
          '<label class="field-label" for="show-archived">Show archived</label>' +
        '</div>' +
      '</div>' +
    '</section>' +

    '<section class="card" aria-labelledby="tickets-heading">' +
      '<header class="card-head card-head-row">' +
        '<h2 id="tickets-heading" class="card-title">Tickets</h2>' +
        '<p class="card-subtitle" id="list-summary" data-testid="list-summary"></p>' +
      '</header>' +
      '<div class="table-wrap">' +
        '<table class="table" data-testid="ticket-table">' +
          '<thead>' +
            '<tr>' +
              '<th scope="col">Ref</th>' +
              '<th scope="col">Title</th>' +
              '<th scope="col">Customer</th>' +
              '<th scope="col">Status</th>' +
              '<th scope="col" class="num">Parts</th>' +
              '<th scope="col">Created</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody id="ticket-rows"></tbody>' +
        '</table>' +
      '</div>' +
      '<div class="pagination">' +
        '<button type="button" class="btn btn-quiet" id="page-prev" data-testid="page-prev">Previous</button>' +
        '<span class="page-indicator" id="page-indicator" data-testid="page-indicator">Page 1 of 1</span>' +
        '<button type="button" class="btn btn-quiet" id="page-next" data-testid="page-next">Next</button>' +
      '</div>' +
    '</section>';

  $('[data-testid="new-ticket"]').addEventListener('click', onNewTicket);

  $('#status-filter').addEventListener('change', (e) => {
    state.list.status = e.target.value;
    state.list.page = 1;
    refreshList();
  });

  // Fires per keystroke, which is ordinary for a search box. refreshList()
  // carries a sequence guard so an out-of-order response cannot win.
  $('#search').addEventListener('input', (e) => {
    state.list.q = e.target.value;
    state.list.page = 1;
    refreshList();
  });

  $('#show-archived').addEventListener('change', (e) => {
    state.list.archived = e.target.checked;
    state.list.page = 1;
    refreshList();
  });

  $('#page-prev').addEventListener('click', () => {
    if (state.list.page > 1) {
      state.list.page -= 1;
      refreshList();
    }
  });

  $('#page-next').addEventListener('click', () => {
    state.list.page += 1;
    refreshList();
  });
}

function ticketsQuery() {
  const l = state.list;
  const params = new URLSearchParams();
  if (l.status && l.status !== 'all') params.set('status', l.status);
  if (l.q) params.set('q', l.q);
  // SPEC-GAP: the checkbox is labelled "Show archived" and the API offers
  // false / true / all. Showing archived alongside live tickets is the reading
  // that matches the label, so the checkbox maps to archived=all, not =true.
  if (l.archived) params.set('archived', 'all');
  params.set('page', String(l.page));
  return '/api/tickets?' + params.toString();
}

function statusBadge(status) {
  const cls = 'badge badge-' + esc(String(status).toLowerCase());
  return '<span class="' + cls + '">' + esc(status) + '</span>';
}

function ticketRowHtml(t) {
  const archivedTag = t.archived ? ' <span class="badge badge-archived">Archived</span>' : '';
  const partCount = t.partCount === undefined || t.partCount === null ? 0 : t.partCount;
  return (
    '<tr data-testid="ticket-row-' + esc(t.id) + '">' +
      '<td class="cell-ref">' +
        '<a href="#/tickets/' + esc(t.id) + '" data-testid="ticket-link-' + esc(t.id) + '">' + esc(t.ref) + '</a>' +
      '</td>' +
      '<td>' + esc(t.title) + archivedTag + '</td>' +
      '<td>' + (t.customer ? esc(t.customer) : '<span class="muted">Not recorded</span>') + '</td>' +
      '<td>' + statusBadge(t.status) + '</td>' +
      '<td class="num">' + esc(partCount) + '</td>' +
      '<td>' + shortDate(t.createdAt) + '</td>' +
    '</tr>'
  );
}

async function refreshList() {
  const seq = ++state.listSeq;
  const result = await api('GET', ticketsQuery());

  // A response for a filter the user has already moved on from must not paint,
  // and neither must one that arrives after the route has changed.
  if (seq !== state.listSeq) return;
  if (!$('#ticket-rows')) return;

  if (!result.ok) {
    handleFailure(result);
    return;
  }
  clearError();

  const payload = result.data || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const page = Number(payload.page) || 1;
  const totalPages = Number(payload.totalPages) || 1;
  const total = Number(payload.total) || 0;
  const pageSize = Number(payload.pageSize) || PAGE_SIZE;

  state.list.page = page; // the server clamps the page; adopt what it returned

  $('#ticket-rows').innerHTML = items.length
    ? items.map(ticketRowHtml).join('')
    : '<tr data-testid="empty-row"><td colspan="6" class="empty-cell">' +
      'No tickets match the current filters.</td></tr>';

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = total === 0 ? 0 : from + items.length - 1;
  $('#list-summary').textContent =
    total === 0 ? 'No tickets' : 'Showing ' + from + '–' + to + ' of ' + total;

  $('#page-indicator').textContent = 'Page ' + page + ' of ' + totalPages;
  $('#page-prev').disabled = page <= 1;
  $('#page-next').disabled = page >= totalPages;
}

function onNewTicket() {
  clearError();
  openFormDialog({
    title: 'New ticket',
    description: 'Raise a repair job. The reference is assigned automatically.',
    saveLabel: 'Create ticket',
    fields: [
      { name: 'title', label: 'Title', required: true, help: 'A short description of the fault.' },
      { name: 'customer', label: 'Customer', help: 'Optional. The business the equipment belongs to.' }
    ],
    onSubmit: async (values) => {
      const result = await api('POST', '/api/tickets', {
        title: values.title,
        customer: values.customer
      });
      if (!result.ok) {
        showDialogError(result.data, result.status);
        return false;
      }
      clearError();
      // Deliberate: the list refetches a beat later, not immediately.
      scheduleRefresh(refreshList);
      return true;
    }
  });
}

// ---------------------------------------------------------------------------
// View: ticket detail
// ---------------------------------------------------------------------------

function partRowHtml(p) {
  const supplier = p.supplier ? esc(p.supplier) : '<span class="muted">No supplier</span>';
  return (
    '<tr data-testid="part-row-' + esc(p.id) + '">' +
      '<td>' + esc(p.name) + '</td>' +
      '<td class="num">' + money(p.cost) + '</td>' +
      '<td class="num">' + esc(p.markup) + '%</td>' +
      '<td class="num">' + esc(p.quantity) + '</td>' +
      '<td>' + supplier + '</td>' +
      '<td class="num" data-testid="part-price-' + esc(p.id) + '">' + money(p.price) + '</td>' +
      '<td class="cell-actions">' +
        '<button type="button" class="btn btn-small" data-testid="part-edit-' + esc(p.id) + '" ' +
          'data-part-id="' + esc(p.id) + '" data-action="edit-part">Edit</button> ' +
        '<button type="button" class="btn btn-small btn-danger-quiet" data-testid="part-delete-' + esc(p.id) + '" ' +
          'data-part-id="' + esc(p.id) + '" data-action="delete-part">Delete</button>' +
      '</td>' +
    '</tr>'
  );
}

function renderNotFound() {
  $('#view').innerHTML =
    '<nav class="breadcrumb" aria-label="Breadcrumb">' +
      '<a href="#/tickets" data-testid="back-to-list">Tickets</a>' +
      '<span class="breadcrumb-sep" aria-hidden="true">/</span>' +
      '<span class="breadcrumb-current">Not found</span>' +
    '</nav>' +
    '<section class="card"><div class="card-body">' +
      '<h1 class="page-title">Ticket not found</h1>' +
      '<p class="card-subtitle">This ticket does not exist, or it has been removed.</p>' +
    '</div></section>';
}

async function renderDetail(id) {
  updateNav();
  const result = await api('GET', '/api/tickets/' + encodeURIComponent(id));

  if (!result.ok) {
    handleFailure(result);
    state.detail = null;
    if (result.status === 404) renderNotFound();
    return;
  }

  const ticket = result.data.ticket;
  const parts = Array.isArray(result.data.parts) ? result.data.parts : [];
  state.detail = { ticket, parts };

  const transitionButtons = (TRANSITIONS[ticket.status] || [])
    .map((next) =>
      '<button type="button" class="btn btn-primary" data-testid="status-to-' + esc(next) + '" ' +
        'data-action="status" data-status="' + esc(next) + '">Mark ' + esc(next) + '</button>')
    .join(' ');

  const archiveLabel = ticket.archived ? 'Unarchive ticket' : 'Archive ticket';

  // Line total for the ticket. Derived from the server's price - never from
  // cost and markup, which the front end must not recompute.
  const totalPrice = parts.reduce((sum, p) => {
    const price = Number(p.price);
    const qty = Number(p.quantity);
    return sum + (Number.isFinite(price) && Number.isFinite(qty) ? price * qty : 0);
  }, 0);

  $('#view').innerHTML =
    '<nav class="breadcrumb" aria-label="Breadcrumb">' +
      '<a href="#/tickets" data-testid="back-to-list">Tickets</a>' +
      '<span class="breadcrumb-sep" aria-hidden="true">/</span>' +
      '<span class="breadcrumb-current">' + esc(ticket.ref) + '</span>' +
    '</nav>' +

    '<div class="page-head">' +
      '<div class="page-head-text">' +
        '<p class="eyebrow" data-testid="ticket-ref">' + esc(ticket.ref) + '</p>' +
        '<h1 class="page-title" data-testid="ticket-title">' + esc(ticket.title) + '</h1>' +
        '<p class="page-subtitle">Customer: ' +
          '<span data-testid="ticket-customer">' +
            (ticket.customer ? esc(ticket.customer) : 'Not recorded') +
          '</span>' +
          ' &middot; Raised ' + shortDate(ticket.createdAt) +
        '</p>' +
        '<p class="status-line">' +
          '<span class="status-label">Status</span> ' +
          '<span data-testid="ticket-status">' + statusBadge(ticket.status) + '</span>' +
          (ticket.archived
            ? ' <span class="badge badge-archived" data-testid="ticket-archived">Archived</span>'
            : '') +
        '</p>' +
      '</div>' +
      '<div class="page-head-actions">' +
        transitionButtons +
        // SPEC-GAP: the spec names one Archive button. It doubles as Unarchive
        // when the ticket is already archived, since a PATCH setting
        // archived:false is the one mutation an archived ticket accepts.
        '<button type="button" class="btn btn-quiet" data-testid="archive" data-action="archive">' +
          esc(archiveLabel) + '</button>' +
      '</div>' +
    '</div>' +

    '<section class="card" aria-labelledby="parts-heading">' +
      '<header class="card-head card-head-row">' +
        '<div>' +
          '<h2 id="parts-heading" class="card-title">Parts</h2>' +
          '<p class="card-subtitle">Price is calculated from cost and markup when the part is saved.</p>' +
        '</div>' +
        '<button type="button" class="btn btn-primary" data-testid="add-part" data-action="add-part">Add part</button>' +
      '</header>' +
      '<div class="table-wrap">' +
        '<table class="table" data-testid="parts-table">' +
          '<thead>' +
            '<tr>' +
              '<th scope="col">Name</th>' +
              '<th scope="col" class="num">Cost</th>' +
              '<th scope="col" class="num">Markup</th>' +
              '<th scope="col" class="num">Qty</th>' +
              '<th scope="col">Supplier</th>' +
              '<th scope="col" class="num">Price</th>' +
              '<th scope="col">Actions</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            (parts.length
              ? parts.map(partRowHtml).join('')
              : '<tr data-testid="no-parts"><td colspan="7" class="empty-cell">' +
                'No parts on this ticket yet.</td></tr>') +
          '</tbody>' +
          (parts.length
            ? '<tfoot><tr>' +
                '<th scope="row" colspan="5">Total (price &times; quantity)</th>' +
                '<td class="num" data-testid="parts-total">' + money(totalPrice) + '</td>' +
                '<td></td>' +
              '</tr></tfoot>'
            : '') +
        '</table>' +
      '</div>' +
    '</section>';
}

/**
 * One delegated click handler for the whole detail view, attached once at boot.
 * #view survives every re-render, so attaching per render would stack up
 * handlers holding stale ticket data; reading state.detail instead keeps the
 * handler correct without rebinding.
 */
function wireViewActions() {
  $('#view').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state.detail) return;

    const action = button.getAttribute('data-action');
    const { ticket, parts } = state.detail;

    if (action === 'status') {
      await patchTicket(ticket.id, { status: button.getAttribute('data-status') });
    } else if (action === 'archive') {
      await patchTicket(ticket.id, { archived: !ticket.archived });
    } else if (action === 'add-part') {
      onAddPart(ticket.id);
    } else if (action === 'edit-part') {
      const part = parts.find((p) => p.id === button.getAttribute('data-part-id'));
      if (part) onEditPart(ticket.id, part);
    } else if (action === 'delete-part') {
      const part = parts.find((p) => p.id === button.getAttribute('data-part-id'));
      if (part) await onDeletePart(ticket.id, part);
    }
  });
}

async function patchTicket(id, patch) {
  clearError();
  const result = await api('PATCH', '/api/tickets/' + encodeURIComponent(id), patch);
  if (!result.ok) {
    // This is where the Ready precondition surfaces: a 409 carrying `unmet`.
    handleFailure(result);
    return false;
  }
  // Neither a create nor a delete, so this repaints immediately - no delay.
  await renderDetail(id);
  return true;
}

function partFields(part) {
  return [
    {
      name: 'name', label: 'Part name', required: true,
      value: part ? part.name : '',
      help: 'As it should appear on the customer invoice.'
    },
    {
      name: 'cost', label: 'Cost', type: 'number', step: '0.01', min: '0', required: true,
      value: part ? part.cost : '',
      help: 'What the workshop pays the supplier, before markup.'
    },
    {
      name: 'markup', label: 'Markup %', type: 'number', step: '0.01', min: '0', required: true,
      value: part ? part.markup : '',
      help: 'Percentage added to the cost to reach the sale price.'
    },
    {
      name: 'quantity', label: 'Quantity', type: 'number', step: '1', min: '0',
      value: part ? part.quantity : '1',
      help: 'Whole units.'
    },
    {
      name: 'supplier', label: 'Supplier',
      value: part && part.supplier ? part.supplier : '',
      help: 'Optional. Leave blank if the part has not been sourced yet.'
    }
  ];
}

/**
 * Numbers and optional values come out of the DOM as strings; the server
 * documents that it coerces them with Number(). An empty quantity is omitted
 * entirely so the server applies its own default rather than being handed a
 * value it would have to reject, and an empty supplier is sent as null, which
 * is the documented "no supplier" representation.
 */
function partBody(values) {
  const body = {
    name: values.name,
    cost: values.cost,
    markup: values.markup,
    supplier: values.supplier === '' ? null : values.supplier
  };
  if (values.quantity !== '') body.quantity = values.quantity;
  return body;
}

function onAddPart(ticketId) {
  clearError();
  openFormDialog({
    title: 'Add part',
    description: 'Record a component used on this repair.',
    saveLabel: 'Add part',
    fields: partFields(null),
    onSubmit: async (values) => {
      const result = await api(
        'POST',
        '/api/tickets/' + encodeURIComponent(ticketId) + '/parts',
        partBody(values)
      );
      if (!result.ok) {
        showDialogError(result.data, result.status);
        return false;
      }
      clearError();
      scheduleRefresh(() => renderDetail(ticketId));
      return true;
    }
  });
}

function onEditPart(ticketId, part) {
  clearError();
  openFormDialog({
    title: 'Edit part',
    description: 'Update ' + part.name + '.', // textContent, so no escaping needed
    saveLabel: 'Save part',
    fields: partFields(part),
    onSubmit: async (values) => {
      const result = await api('PATCH', '/api/parts/' + encodeURIComponent(part.id), partBody(values));
      if (!result.ok) {
        showDialogError(result.data, result.status);
        return false;
      }
      clearError();
      await renderDetail(ticketId); // an edit is neither a create nor a delete
      return true;
    }
  });
}

async function onDeletePart(ticketId, part) {
  clearError();
  const confirmed = await openConfirm({
    message: 'Delete the part "' + part.name + '" from this ticket? This cannot be undone.',
    confirmLabel: 'Delete part'
  });
  if (!confirmed) return;

  const result = await api('DELETE', '/api/parts/' + encodeURIComponent(part.id));
  if (!result.ok) {
    handleFailure(result);
    return;
  }
  scheduleRefresh(() => renderDetail(ticketId));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
//
// Hash routing, so a reload of #/tickets/t3 lands on that ticket. The server
// serves index.html for any unknown non-/api path, and the router reads
// location.hash on first paint as well as on every hashchange, so a deep link
// never bounces back to the list.

function currentRoute() {
  const path = (window.location.hash || '').replace(/^#/, '');
  const segments = path.split('/').filter(Boolean);

  if (segments[0] === 'login') return { name: 'login' };
  if (segments[0] === 'tickets' && segments[1]) {
    return { name: 'detail', id: decodeURIComponent(segments[1]) };
  }
  if (segments[0] === 'tickets') return { name: 'list' };
  return { name: 'unknown' };
}

async function route() {
  const seq = ++state.routeSeq;

  // Any pending delayed refresh belongs to the view being left behind.
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    hideRefreshing();
  }

  const r = currentRoute();

  if (r.name === 'unknown') {
    window.location.hash = '#/tickets'; // fires hashchange, which re-routes
    return;
  }

  if (r.name === 'login') {
    clearError();
    renderLogin();
    return;
  }

  // Every other route needs a session. When the user is not known yet (first
  // paint, or a reload) ask the server before deciding to redirect, so that a
  // deep link into a live session still resolves to the view that was asked
  // for.
  if (!state.user) {
    const me = await api('GET', '/api/me');
    if (seq !== state.routeSeq) return; // superseded while we were waiting
    if (!me.ok) {
      if (me.status !== 401) showError(me.data, me.status);
      window.location.hash = '#/login';
      return;
    }
    state.user = me.data && me.data.user ? me.data.user : null;
  }

  updateNav();
  clearError();

  if (r.name === 'detail') {
    await renderDetail(r.id);
  } else {
    state.detail = null;
    renderListShell();
    await refreshList();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

wireNav();
wireDialogs();
wireViewActions();
window.addEventListener('hashchange', () => { route(); });

if (!window.location.hash) {
  // Normalise the entry URL so the address bar always shows a real route.
  // replace() rather than assignment, to keep the history stack clean.
  window.location.replace(window.location.pathname + window.location.search + '#/tickets');
}

route();
