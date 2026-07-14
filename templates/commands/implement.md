---
name: implement
description: Do — execute the SPEC in a fresh context, validating each step.
---
Run the **Do** move of the Contextium Loop. Start from a fresh context and load the SPEC.

1. Implement task by task, in the order the SPEC lays out.
2. Validate after each change — run the command that proves that step works before moving on.
3. When the build is done, run it end to end against the SPEC's success criteria, including the edge cases (0 / 1 / empty / max / error).
4. Match the weight of the solution to the problem: an inline script beats a service that does the same thing. Land the full scope; do not defer in-scope work to "later".

If something in the SPEC turns out wrong, surface it and revise the SPEC — do not silently build something else.
