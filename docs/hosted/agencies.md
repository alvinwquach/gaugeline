# Hosted: agencies, client viewers and the weekly update

The hosted version of Gaugeline (in progress, not released) is built for agencies that look after many
small-business sites. This page covers grouping sites by **client**, giving a client a **view-only login**
to their own site, and the **invite** that creates that login. The database enforces all of it: a client
viewer cannot read another client's site, whatever the app does.

## An example: one agency, a bar and a pop-up kitchen

Northgate Studio builds and looks after sites for two businesses:

| Client                | Site                   | Client viewer          |
| --------------------- | ---------------------- | ---------------------- |
| Tidewater Hospitality | The Tidewater Bar      | the bar's manager      |
| Juniper Kitchens      | Juniper Pop-up Kitchen | the pop-up's organiser |

Each viewer signs in and sees their own site's last run and findings in plain words. The bar's manager
never sees the pop-up, its runs, its findings or its weekly update, and neither sees the inbox, the
decisions or the list of Northgate's clients.

This is the seeded test database (`apps/hosted/db/__tests__/harness.ts` plus the agencies migration, `*_agencies.sql`),
run with `psql` 16 as written. The set-up groups the two sites and adds the pop-up's viewer; then the
viewer reads, and a member who is not an admin tries to invite someone as an admin:

```sql
-- set-up, as the schema owner: two clients, each site grouped, a second client viewer for the pop-up
insert into clients (id, org_id, name) values
  ('c1000000-0000-4000-8000-0000000000c1', '0a000000-0000-4000-8000-00000000000a', 'Tidewater Hospitality'),
  ('c2000000-0000-4000-8000-0000000000c2', '0a000000-0000-4000-8000-00000000000a', 'Juniper Kitchens');
update sites set client_id = 'c1000000-0000-4000-8000-0000000000c1' where id = 'a1000000-0000-4000-8000-0000000000a1';
update sites set client_id = 'c2000000-0000-4000-8000-0000000000c2' where id = 'a2000000-0000-4000-8000-0000000000a2';
insert into members (org_id, user_id, role, site_id) values ('0a000000-0000-4000-8000-00000000000a',
  '33333333-0000-4000-8000-000000000002', 'client', 'a2000000-0000-4000-8000-0000000000a2');

-- as the pop-up's client viewer
begin;
select set_config('request.jwt.claims', '{"sub":"33333333-0000-4000-8000-000000000002"}', true);
set local role authenticated;
select name, url from sites;
select count(*) as findings_i_can_read from findings;
select count(*) as clients_i_can_read from clients;
rollback;

-- as Northgate's member (not an admin): invite the bar's manager as an admin
begin;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000002"}', true);
set local role authenticated;
insert into invites (org_id, email, role, invited_by, token_sha256)
  values ('0a000000-0000-4000-8000-00000000000a', 'bar-manager@tidewater-bar.test', 'admin',
          '11111111-0000-4000-8000-000000000002', repeat('ab', 32));
rollback;
```

Output (the `set_config` lines trimmed):

```text
          name          |            url
------------------------+----------------------------
 Juniper Pop-up Kitchen | https://juniper-popup.test
(1 row)

 findings_i_can_read
---------------------
                   0
(1 row)

 clients_i_can_read
--------------------
                  0
(1 row)

ERROR:  new row violates row-level security policy for table "invites"
```

The bar's broken menu link is a finding in the same agency, and the pop-up's viewer counts none of it.

## Clients and sites

A **client** is one business the agency works for (`clients`: a name, in one organisation). A site has at
most one client (`sites.client_id`). The key covers the organisation too, so a site cannot be grouped
under another agency's client. Owners and admins create clients and move sites between them; members read
them; client viewers do not see the list at all.

To move a site to another client, set its `client_id`. Updates already written for the old client keep
the site in their snapshot (see the weekly update below), so history does not move with it. A client that
still has sites cannot be deleted: move its sites first.

## Client viewers

A client viewer is a member with role `client` and exactly one site (`members.site_id`). Row-level
security lets them read that site, its runs, findings, what changed and its consent record, and nothing
else: no drafts, no decisions, no clients, no other member. They cannot write anything, and they cannot
change their own role or site (only owners and admins change members, and only an owner touches an owner).

## Invites

An invite is data: the app makes a random token, shows the link once, and stores only the token's SHA-256
(`invites.token_sha256`, which no signed-in role can read back). Nothing in this branch sends an email.

| Who invites    | May invite                   |
| -------------- | ---------------------------- |
| owner          | owner, admin, member, client |
| admin          | admin, member, client        |
| member, client | nobody                       |

Nobody can invite a role above their own, and an invite is in the inviter's own name. A client invite
names one site of the same organisation. The invite expires after 7 days (set by the database, not the
inviter), can be revoked, and is used once.

`private.accept_invite(token)` turns it into a member row for the signed-in person, and refuses when:

- the token is unknown, expired, revoked or already used, or the signed-in email is not the invited one
  (all with the same message, so it does not reveal which tokens exist);
- the person who sent it no longer holds a role that may grant it (an admin who has since become a member);
- the person is already in that organisation.

## Run only on sites you own or have permission to test

A client viewer reads results; nothing here runs a probing check. Probing checks still need the site
owner's consent row ([data model](./data-model.md#consent-to-probing-checks)).
