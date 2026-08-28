# Staged migrations — NOT applied by `prisma migrate`

Prisma only reads `prisma/migrations/`. Folders here are written and reviewed
but deliberately not yet active.

## `20260828180000_b2_step2_swap_user_fks_to_control_plane`

The B2 "migration M" — swaps the `*_userId_fkey` constraints from
`store_spy.User` to `control_plane.users`. It is held here because the instant
it lands, EVERY integration-test fixture that creates a `store_spy.User` with a
child row needs a `control_plane` account too. Move it back into
`prisma/migrations/` as one unit with the fixture migration ("step 2·M"),
between the 2·A merge and the 2·B cutover. Scratch-verified already — see
docs/store-spy-control-plane-b2.md.
