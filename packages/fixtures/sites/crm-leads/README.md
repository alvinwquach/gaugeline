# crm-leads

An invented coaching studio (Tideline Coaching) for the CRM lead checks (X55). Nothing here is a real
business, account or form. The CRM side is replayed from packages/fixtures/salesforce-mcp.

- One Salesforce Web-to-Lead form. It sends `first_name`, `last_name`, `email`, `company`,
  `lead_source` and `00N5e000001AbCd` (a custom field, sent by id), which Lead has, and `promo_code` and
  `preferred_time`, which it does not: `crm-field-names`.
- With `tideline-leads` replayed, 12 of the 40 leads of the week have an empty Lead Source:
  `crm-lead-source`. With `tideline-quiet`, the last lead was five days ago: `crm-went-quiet`.
