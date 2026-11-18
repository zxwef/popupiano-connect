# PopuConnect

- Write source code, comments, user-facing text, scripts, tests, and documentation in English.
- Build Desktop from the repository root with `PopuConnect.slnx`. Windows sources, tests, and scripts are in `apps/desktop`.
- Build Web from `apps/web` with `npm ci` and `npm run build`. The result must work as a static site.
- Document verified hardware commands in `docs/protocols`. Include the device generation, transport, and verification method. Publish a battery protocol after verifying the response format and its interpretation.
- Keep references in `docs/research/README.md`. Store hypotheses, work in progress, and unconfirmed observations in ignored `docs/research/*.local.md` files.
- Keep shared anonymized MIDI data in `tests/fixtures` and local captures in `artifacts/`.
