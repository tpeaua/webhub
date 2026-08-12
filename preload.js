'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('apps:list'),
  profiles: () => ipcRenderer.invoke('apps:profiles'),
  open: (id) => ipcRenderer.invoke('apps:open', id),
  add: (data) => ipcRenderer.invoke('apps:add', data),
  update: (id, data) => ipcRenderer.invoke('apps:update', id, data),
  remove: (id) => ipcRenderer.invoke('apps:remove', id),
  refreshIcon: (id) => ipcRenderer.invoke('apps:refreshIcon', id),
  pickIcon: (id) => ipcRenderer.invoke('icon:pick', id),
  rebuild: () => ipcRenderer.invoke('apps:rebuild'),
  onChanged: (cb) => ipcRenderer.on('apps:changed', () => cb()),
});
