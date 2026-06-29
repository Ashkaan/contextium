# Boundary Inputs

Enumerate the edges before writing the happy path. Always loaded.

## boundary-inputs
When implementing any new computation, flow, or parser, MUST enumerate the expected behavior at the
boundaries before coding the common case: **0, 1, empty, max, and error** inputs. Write down what each
should do — an empty list yields an empty result (not a crash), a malformed row is dropped-and-counted
(not silently skipped), the max case doesn't overflow a buffer or a rate limit.

The boundaries are also the test plan: each edge you enumerate becomes a test case. Code that only
handles the typical input is half-written; the bugs that reach production almost always live at 0, 1,
empty, max, or error.

Pairs with @rule:mechanisms-not-prose — the enumerated edges should land as actual tests, not a
comment promising they were considered.
