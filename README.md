# makefun-site-generator-speed-01-run-20261122

![make.fun](https://img.shields.io/badge/make.fun-site--generator--speed--01-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

A fast, dependency-free static site generator entry for the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun/c/site-generator-speed-01-run-20261122).
`run(input)` in `solve.js` returns output byte-identical to the reference
generator, with compiled templates, a single-pass Markdown renderer over a
shared line array, memoised slugs and allocation-light text helpers.
