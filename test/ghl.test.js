import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGhl } from '../src/ghl.js';

// GHL's /contacts/upsert REPLACES the tag list on an existing contact, so a
// source tag sent there wipes every other tag. Tags must go through the
// additive POST /contacts/{id}/tags instead.
function fakeFetch(log) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method: init.method || 'GET', path: u.pathname, body });
    let out = {};
    if (u.pathname.endsWith('/contacts/upsert')) out = { new: false, contact: { id: 'c1', tags: ['keep:me'] } };
    else if (u.pathname === '/contacts/c1') out = { contact: { id: 'c1', tags: ['keep:me'] } };
    else if (u.pathname.includes('/contacts/search') || u.pathname.includes('duplicate')) out = { contacts: [], contact: null };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('ghl: upsertContact never sends tags to /contacts/upsert; source is added additively', async () => {
  const log = [];
  const ghl = createGhl({ pit: 'pit-test', fetchImpl: fakeFetch(log), detectSchemaDrift: false });
  const { contactId } = await ghl.upsertContact({ email: 'a@b.com', firstName: 'A', source: 'src:phoneburner' });
  assert.equal(contactId, 'c1');
  const upsert = log.find((r) => r.path.endsWith('/contacts/upsert'));
  assert.ok(upsert, 'upsert called');
  assert.equal(upsert.body.tags, undefined);
  const tagPost = log.find((r) => r.method === 'POST' && r.path === '/contacts/c1/tags');
  assert.deepEqual(tagPost && tagPost.body.tags, ['src:phoneburner']);
});

// GHL rejects a phone lookup on /contacts/search/duplicate (422 "property phone
// should not exist"), which broke every new PhoneBurner contact that had a phone.
test('ghl: upsertContact with a phone never does a phone duplicate lookup', async () => {
  const log = [];
  const base = fakeFetch(log);
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.includes('/contacts/search/duplicate') && u.searchParams.has('phone')) {
      log.push({ method: 'GET', path: u.pathname, phoneLookup: true });
      return new Response(JSON.stringify({ message: ['property phone should not exist'] }), { status: 422 });
    }
    return base(url, init);
  };
  const ghl = createGhl({ pit: 'pit-test', fetchImpl, detectSchemaDrift: false });
  const { contactId } = await ghl.upsertContact({ email: 'new@b.com', phone: '8135550142', firstName: 'N', source: 'src:phoneburner' });
  assert.equal(contactId, 'c1');
  assert.ok(!log.some((r) => r.phoneLookup), 'no phone duplicate lookup');
  const upsert = log.find((r) => r.path.endsWith('/contacts/upsert'));
  assert.equal(upsert.body.phone, '8135550142');
});
