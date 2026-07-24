# Desktop search migration for 0.7.0

Fluxmail Desktop should treat `@fluxmail/core` as the source of truth for search parsing, formatting, diagnostics, and account capability checks. Desktop source is not part of this repository.

## Query input

Call `parseEmailSearch(input)` as the person types. Keep the returned tokens for rendering ranges and invalid terms. A result with `valid: false` still contains the filters that were parsed safely, but Desktop must not run that partial query automatically.

Use `formatEmailSearch(query)` only with a successful `NormalizedPortableEmailQuery`. The formatter emits a deterministic string that parses back to the same normalized structure.

Autocomplete should offer:

- `from:`
- `to:`
- `subject:`
- `in:`
- `is:read` and `is:unread`
- `is:starred` and `is:unstarred`
- `has:attachment` and `-has:attachment`
- `after:` and `before:`

Remove boolean expression, label, category, size, relative-date, and sent-date operators. Use a date picker or insert a valid `YYYY-MM-DD` value.

## Account selection and capabilities

Search one account through Fluxmail at a time. Use `requiredSearchFilters()` and `supportsPortableEmailQuery()` before running a portable query. Use `intersectSearchCapabilities()` only to decide which portable filters and folder roles can appear in a multi-account Desktop interface.

Custom folders are account specific. Discover them with `listFolders()` and send the resolved folder through the structured query field after the user selects one.

Keep Gmail syntax and Outlook KQL in a separate native-search mode. Native mode uses `rawProviderQuery` and requires exactly one compatible account.

## Diagnostics

Display parser errors next to their token ranges. Warnings should not block search. For example, Fluxmail keeps `form:ann@example.com` as literal text and suggests `from:`.

REST returns search diagnostics in response metadata. MCP and CLI JSON results include the same diagnostics. The CLI also writes warnings to standard error.

## Pagination

Treat a page token as opaque. Send it back with the same account, normalized query, and page size within one hour.

When `incomplete` is true, do not present an empty page as "no matches." Desktop can fetch up to three empty incomplete pages automatically. After that, show a "Continue searching" control. Display `provider_limit` as terminal when the response does not include another token.

## Breaking field migration

Replace:

```ts
{ unreadOnly: true, starredOnly: true }
```

with:

```ts
{ read: false, starred: true }
```

Do not convert a missing legacy flag to `false`. Omission means that Fluxmail should not filter on that state.
