'use strict';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const subtitle = document.getElementById('subtitle');
const addBtn = document.getElementById('addBtn');
const rebuildBtn = document.getElementById('rebuildBtn');
const buildStatus = document.getElementById('buildStatus');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const form = document.getElementById('form');
const cancelBtn = document.getElementById('cancelBtn');
const profileList = document.getElementById('profile-list');

const fName = document.getElementById('f-name');
const fUrl = document.getElementById('f-url');
const fProfile = document.getElementById('f-profile');
const fIcon = document.getElementById('f-icon');

let apps = [];
let editingId = null;

function render() {
  grid.innerHTML = '';
  const profiles = new Set(apps.map((a) => a.profile));
  subtitle.textContent = apps.length
    ? `${apps.length} app${apps.length === 1 ? '' : 's'} · ${profiles.size} profile${profiles.size === 1 ? '' : 's'}`
    : 'No apps yet';

  empty.classList.toggle('hidden', apps.length > 0);

  for (const a of apps) {
    const card = document.createElement('div');
    card.className = 'card';
    card.title = a.url;

    let iconHtml;
    if (a.icon) {
      iconHtml = `<img src="${a.icon}" alt="" draggable="false" />`;
    } else {
      const letter = (a.name || '?').trim().charAt(0).toUpperCase();
      iconHtml = `<div class="tile" style="background:${a.color || '#5b42e8'}">${letter}</div>`;
    }

    card.innerHTML = `
      ${iconHtml}
      <div class="name">${escapeHtml(a.name)}</div>
      <div class="profile">${escapeHtml(a.profile)}</div>
      <div class="actions">
        <button class="icon-btn" data-act="edit" title="Edit">✎</button>
        <button class="icon-btn" data-act="icon" title="Choose icon">🖼</button>
        <button class="icon-btn" data-act="del" title="Remove">🗑</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.actions')) return;
      window.api.open(a.id);
    });
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openModal(a));
    card.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (confirm(`Remove "${a.name}"?`)) {
        apps = await window.api.remove(a.id);
        render();
      }
    });
    card.querySelector('[data-act="icon"]').addEventListener('click', async () => {
      const dataUrl = await window.api.pickIcon(a.id);
      if (dataUrl) { a.icon = dataUrl; render(); }
    });

    grid.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function openModal(existing) {
  editingId = existing ? existing.id : null;
  modalTitle.textContent = existing ? 'Edit app' : 'Add app';
  fName.value = existing ? existing.name : '';
  fUrl.value = existing ? existing.url : '';
  fProfile.value = existing ? existing.profile : '';
  fIcon.value = existing ? (existing.customIconUrl || '') : '';
  refreshProfileDatalist();
  modal.classList.remove('hidden');
  fName.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  editingId = null;
}

function refreshProfileDatalist() {
  profileList.innerHTML = '';
  const set = new Set(apps.map((a) => a.profile));
  for (const p of set) {
    const o = document.createElement('option');
    o.value = p;
    profileList.appendChild(o);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: fName.value,
    url: fUrl.value,
    profile: fProfile.value || 'default',
    iconUrl: fIcon.value || null,
  };
  if (editingId) {
    apps = await window.api.update(editingId, { ...data, refetchIcon: !fIcon.value });
  } else {
    apps = await window.api.add(data);
  }
  closeModal();
  render();
});

cancelBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
addBtn.addEventListener('click', () => openModal(null));

rebuildBtn.addEventListener('click', async () => {
  rebuildBtn.disabled = true;
  buildStatus.textContent = 'Rebuilding…';
  const r = await window.api.rebuild();
  rebuildBtn.disabled = false;
  if (r && r.ok) {
    buildStatus.textContent = 'Done ✓';
    setTimeout(() => { buildStatus.textContent = ''; }, 5000);
  } else {
    buildStatus.textContent = 'Failed: ' + ((r && r.error) || 'unknown');
  }
});

window.api.onChanged(() => { refresh(); });
async function refresh() {
  apps = await window.api.list();
  render();
}
refresh();
