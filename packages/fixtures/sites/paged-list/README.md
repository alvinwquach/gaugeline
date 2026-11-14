# paged-list

An invented gardening journal for the list checks (G12c). Nothing here is a real person or site.

- The page links to `/?page=2` and `/?page=3`, and the fixture server ignores the query, so page 2
  serves page 1 again: `pagination-same-content`.
- One article carries `data-sanity="drafts.abc123"`: `drafts-live`.
- `/news.xml` and `/blog.xml` list the same three posts: `feed-duplicate`.
