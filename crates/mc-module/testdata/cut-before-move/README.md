# Broca refusing a view that cuts before the move's cut (November 22)

Synthetic test rig (`a_view_cutting_before_the_moves_cut_is_refused`): a head imported with
messages msg_u1, msg_a1, msg_u2, msg_a2, msg_u3, ... and the move's first view (version 1) cutting
through `msg_a2`. Each later view below is refused, and view 1 stays in force.

- `apply-view-cut-before-move.json`: broca's `session.apply_view` answer to view 2 cutting through
  `msg_a1`, which is in the history the move's cut sealed.
- `notice-cut-before-move-0.json`: the notice telling the provider of the refusal of the same
  view handed over as a ride answer (its `view_refused` event).
- `notice-cut-before-move-1.json`: the same, for view 2 with no cut at all.

Each notice is the params value broca passed to `compaction.notice`. A view cutting through
`msg_a2` itself or any later entry applies. Broca records no move cut for heads imported before
the build that added this refusal, so it never refuses their views this way.
