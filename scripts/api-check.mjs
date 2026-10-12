// API probe: health + full designs CRUD + duplicate, via direct :3001.
const base = 'http://localhost:3001';
const j = (r) => r.json();
const health = await (await fetch(base + '/api/health')).json();
console.log('HEALTH ' + JSON.stringify(health));

const created = await (await fetch(base + '/api/designs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Probe One', canvas: { width: 1200, height: 630 } }),
})).json();
console.log('CREATE ' + JSON.stringify({ id: created.design?.id, title: created.design?.title }));
const id = created.design?.id;

const list1 = await (await fetch(base + '/api/designs')).json();
console.log('LIST ' + list1.designs?.length + ' first=' + list1.designs?.[0]?.title);

const updated = await (await fetch(base + '/api/designs/' + id, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Probe One Renamed', design: { canvas: { width: 5, height: 5, background: '#fff' }, elements: [] } }),
})).json();
console.log('UPDATE ' + JSON.stringify(updated.design));

const got = await (await fetch(base + '/api/designs/' + id)).json();
console.log('GET ' + JSON.stringify({ title: got.design?.title, els: got.design?.design?.elements?.length }));

const dup = await (await fetch(base + '/api/designs/' + id + '/duplicate', { method: 'POST' })).json();
console.log('DUPLICATE ' + JSON.stringify({ id: dup.design?.id, title: dup.design?.title }));

const del1 = await fetch(base + '/api/designs/' + id, { method: 'DELETE' });
const del2 = await fetch(base + '/api/designs/' + dup.design?.id, { method: 'DELETE' });
console.log('DELETE ' + del1.status + ',' + del2.status);
const list2 = await (await fetch(base + '/api/designs')).json();
console.log('LIST-AFTER ' + list2.designs?.length);
console.log('API CHECK DONE');
