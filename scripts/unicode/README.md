# Unicode confusable data

`confusables-17.0.0.txt` is the pinned Unicode Security Mechanisms data file
used to generate Open Pixels' browser-safe sensitive-key skeleton table.

- Standard/data version: Unicode 17.0.0 / UTS #39
- Source: <https://www.unicode.org/Public/17.0.0/security/confusables.txt>
- SHA-256: `091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a`
- Upstream documentation: <https://www.unicode.org/reports/tr39/>
- License: [Unicode License v3](./LICENSE.txt)

The committed source file and generated TypeScript table make builds offline,
deterministic, and auditable. The generated profile contains only non-ASCII
letters or numbers whose UTS #39 target normalizes to ASCII alphanumerics. It
does not remap ASCII source characters, because full confusable skeletons can
change ordinary ASCII spelling (for example, visual equivalence classes). The
runtime only activates the profile inside identifier words containing an ASCII
letter and non-ASCII letters/numbers. A numeric suffix by itself does not turn
a pure multilingual identifier into a mixed-script key. Remaining non-ASCII
letters in such a word become a bounded single-code-point wildcard during
sensitive semantic classification; emitted keys are never changed.

To update:

1. Review the new UTS #39 release and Unicode license.
2. Change the version, URL, and expected SHA-256 in the generator.
3. Run `bun run generate:unicode-confusables --refresh`.
4. Review both the vendored data and generated-table diff.
5. Run the independent generated corpus, browser-size/performance, package, and
   consumer gates before committing.

Never replace the versioned URL with `latest`; an update is a reviewed source
change rather than an ambient build-time network dependency.
