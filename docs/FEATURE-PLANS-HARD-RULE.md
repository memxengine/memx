      105 +## HARD RULE — feature plans must be written, not faked
      106 +
      107 +**When Christian asks for a plan-doc, write the full plan-doc in the SAME turn
      108 +that the F-number is created.** No exceptions.
      109 +
      110 +What is NOT acceptable:
      111 +
      112 +- Adding a row to `docs/FEATURES.md` with a `[plan](features/F999-x.md)`
      113 +  link that points at a file you haven't written.
      114 +- Adding a row to `docs/ROADMAP.md` describing a feature that has no
      115 +  plan-doc behind it.
      116 +- Saying "planned" / "added to roadmap" / "F-numbered" when what you
      117 +  actually did is add an index row and nothing else.
      118 +- Deferring the plan with "I'll write the plan next" — you won't. The
      119 +  context that motivated the plan evaporates within a turn, and the user
      120 +  ends up days later with a roadmap full of topic strings and no
      121 +  reasoning behind them. It is AI slop.
      122 +
      123 +What IS required:
      124 +
      125 +1. The plan-doc file (`docs/features/F<nn>-<slug>.md`) exists on disk
      126 +   BEFORE the `FEATURES.md` / `ROADMAP.md` entries are added.
      127 +2. The plan-doc captures the motivation, scope (in + explicit
      128 +   non-goals), architecture sketch, dependencies, and rollout while the
      129 +   conversation context that produced it is still live.
      130 +3. If the scope is still fuzzy when the user asks for the plan, write
      131 +   an interim plan-doc that records "open questions" at the top and
      132 +   call it out — don't silently skip the file.
      133 +4. The commit that introduces the F-number is the one that introduces
      134 +   the plan-doc. One commit, all three files (plan-doc + FEATURES.md +
      135 +   ROADMAP.md) land together.
      136 +
      137 +Audit on 2026-04-23 found 43 feature entries in the index with no
      138 +plan-doc behind them — the reasoning that originally justified them
      139 +was lost forever because the plans were never written. That is the
      140 +exact cost this rule exists to prevent. Do not repeat it.
      141 +
      142 +Trigger check before committing any change that touches FEATURES.md or
      143 +ROADMAP.md: does every F-number mentioned in the diff have a
      144 +corresponding `docs/features/F<nn>-*.md` file? If not, write it now
      145 +or remove the index row. No "I'll do it next turn." There is no next
      146 +turn for context.
      147 +
      148  ## Verification before "this works"
      149
      150  Typecheck is not verification. `pnpm typecheck` only proves the code

