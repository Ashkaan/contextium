# Simplest Solution Default

Reach for the lightest mechanism that actually works. Always loaded.

## simplest-solution-default
Default to the simplest thing that solves the problem. The usual ladder, lightest first:

> inline script  >  shared function  >  scheduled job  >  long-running daemon  >  new service

Climb it only when the rung you're on genuinely can't do the job — not because a heavier shape feels
more "real." A few specific traps:

- **"Shared by other automations" means a shared function, not a deployed service.** Import it; don't
  stand up a daemon to host it.
- **Don't build infrastructure when a function call works.** A 30-line script beats a 3,000-line
  service that does the same thing and now has to be deployed, monitored, and kept alive.
- **Weigh defense-in-depth against the real threat model.** Per-caller credentials, allowlists, retry
  loops, and circuit breakers are right for hostile multi-tenant systems. For a single-user setup
  where every caller is your own code, they are usually over-engineering.

When a reviewer or your own instinct says "this needs more structure," make it justify the weight
against the actual requirement. The first question on any new component is "what is the lightest shape
that satisfies the need?" — answered before, not after, you build. Pairs with @rule:depth-policy.
