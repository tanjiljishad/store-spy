# Milestone 9, Sub-phase B — Okendo Review Intelligence Foundation

## 1. Status

**BLOCKED at Phase 1 (commercial-use gate).** No collector, provider abstraction, schema change, migration, UI, or test was implemented. This report exists because the Sub-phase B brief's own protocol (Section 1: "If the research document does NOT establish that our intended use is permitted: STOP implementation... document the exact unresolved question... report that implementation is blocked") requires documenting a STOP rather than silently skipping it. Phases 2–16 of the brief's implementation order were not started.

## 2. Commercial-use gate decision

**Decision: NOT CLEARED. Do not implement.**

The Sub-phase A research document (`docs/milestone-9-review-intelligence-research.md`, Section 34/STOP 6 and the "Sub-phase B readiness" verdict) left this as an open, unresolved question and explicitly required a human decision before proceeding. Before writing any code, Phase 1 of this sub-phase went further than the prior research did — it located and read Okendo's actual Terms of Service, which the Sub-phase A research had searched for but not found. The result is not merely "still unresolved" — it is **specific, adverse evidence** that the intended use (ongoing, automated, third-party, commercial collection from an undocumented endpoint for use inside a paid competitive-intelligence product) is very plausibly prohibited by Okendo's own terms.

### Evidence found this sub-phase

Source: [Okendo Terms](https://okendo.io/legal-end-users/terms/) ("end-user" terms — the applicable document, since Bellwether is neither a merchant licensing Okendo nor a shopper using the widget for its intended purpose; Section 2.1 states Okendo "provides technology and platform services to you and to ecommerce merchants," and Section 1.2.4 defines "you"/"your" broadly as "you, any entity or firm you're authorised to represent" — language wide enough to plausibly cover a third-party automated client, not just a browsing human):

- **Section 5.1.3** (quoted verbatim): prohibits users from accessing "the Services by any means (automated or otherwise) **other than through our currently available, published interfaces**."
  - This is directly relevant because Sub-phase A's own Section 13 already established that the endpoint Bellwether would call (`api.okendo.io/v1/stores/{subscriberId}/reviews`) is **not published or indexed anywhere findable** — it was discovered by reading Okendo's client-side widget JavaScript, not from any documentation page. A confirmed check this sub-phase of the one documentation page that should describe it (`docs.okendo.io/on-site/storefront-rest-api`) found it contains no usable content — no endpoint description, no usage terms, nothing. An endpoint with no public documentation is difficult to characterize as a "currently available, published interface" under this clause's own wording.
- **Section 5.1.4** (quoted verbatim): prohibits users from "scrap[ing] the Services, and particularly scrap[ing] Content (as defined below) from the Services, **without the express prior written consent of Okendo**."
  - Storing review data (even metadata-only, per the research document's own Section 28 recommendation) obtained by programmatically calling this endpoint on an ongoing basis is a reasonable description of "scraping Content from the Services" under plain reading.
- **Section 6.5** (quoted verbatim): "this site or any portion of this site may not be reproduced, duplicated, copied, sold, re-sold or **otherwise exploited for any commercial purpose**" that is not expressly permitted by Okendo.
  - Bellwether is a paid commercial product. Surfacing collected review counts/ratings/velocity to paying subscribers is commercial exploitation of the underlying data under a plain reading of this clause.
- Additional, weaker, corroborating signal: `api.okendo.io/robots.txt` returns a blanket `{"message":"Forbidden"}` (HTTP 403) rather than a robots.txt file or a 404. This does not by itself prove anything about API terms, but it is consistent with — not contradictory to — this host not being intended as an openly documented, arbitrary-consumer public interface.

### Why this is a STOP, not a CONDITIONAL GO

The Sub-phase B brief is explicit and was followed literally: *"A public unauthenticated endpoint does NOT automatically mean unrestricted commercial redistribution is permitted"* (Section 1) and *"Do NOT work around the gate by assuming 'it's public, therefore it's allowed.'"* The evidence found here is a direct, textbook instance of exactly that trap — the endpoint is technically reachable and requires no credential, but Okendo's own terms, read plainly, restrict both the *access method* (automated access to non-published interfaces, absent Okendo's consent) and the *use* (commercial exploitation) that this feature would require. This satisfies **STOP condition 1** ("Okendo commercial-use rights cannot be established sufficiently" — in fact, available evidence points the other way) and plausibly **STOP condition 3** ("The endpoint's terms prohibit our intended commercial use") from the brief's Section 28.

### What is NOT being claimed

This is not a legal opinion, and it should not be treated as a final, dispositive legal conclusion. Genuine ambiguity remains:
- Whether "the Services" in these terms is intended to cover the underlying data API at all (as opposed to just the okendo.io marketing/dashboard site) is not stated explicitly anywhere read this sub-phase.
- Whether a low-volume, non-destructive, attribution-preserving, read-only competitive-intelligence use would be treated the same as bulk commercial scraping by Okendo in practice is unknown — companies sometimes tolerate or license exactly this kind of use on request.
- No attempt was made to contact Okendo, since doing so is a business/legal action outside this sub-phase's read-only-research-and-code scope, not a technical one.

### What must be confirmed before this can move forward

Exactly one of the following, obtained by the user/business (not by this agent):
1. **Express written permission from Okendo** to programmatically collect review metadata from this endpoint for use in a third-party commercial product, ideally covering: access method (the undocumented Storefront REST endpoint), data use (aggregate count/rating/velocity display, not resale of raw review content), and volume (the bounded, ~1-request-per-store-per-check pattern from Sub-phase A's Section 25 cost model); **or**
2. **A formal legal review** (not an AI-generated interpretation) of Okendo's Terms of Service concluding that Bellwether's specific intended use does not fall within the Section 5.1.3/5.1.4/6.5 restrictions quoted above, with that review's reasoning documented; **or**
3. **A product decision to abandon Okendo as a review data source** and either close out Milestone 9 without a review-intelligence feature, or restart provider research from Judge.me/Stamped/Yotpo/Loox (each already carries its own separate, likely-harder auth barrier per the Sub-phase A research, Sections 6–9, and would need this same gate check repeated for whichever one is chosen).

This agent has no ability to grant, negotiate, or substitute for any of the three items above, and did not attempt to.

## 3. Files changed

None.

## 4. Files deleted

None.

## 5. Schema changes

None. No Prisma schema edits were made.

## 6. Migration

None. No migration was created or run.

## 7. Dependencies

None added, none removed. `package.json`/`package-lock.json` untouched by this sub-phase.

## 8. Provider architecture

Not implemented. Design deferred until the gate in Section 2 is resolved — building the abstraction now, with only a blocked provider to hang off it, would produce untested, unused scaffolding, which the project's own engineering conventions (no speculative abstractions) argue against.

## 9. Okendo collection method

Not implemented.

## 10. Security model

Not implemented. (Sub-phase A's Section 27 security analysis remains valid research and does not need to be redone once/if the gate clears.)

## 11. Rate limiting

Not implemented.

## 12. Response-size protection

Not implemented.

## 13. Persistence model

Not implemented.

## 14. Baseline behavior

Not implemented.

## 15. Velocity calculation

Not implemented.

## 16. Accumulation behavior

Not implemented.

## 17. Scheduler integration

Not implemented.

## 18. API contract

Not implemented.

## 19. UI changes

None. No Fable-derived component was touched.

## 20. Entitlement behavior

Not touched. No FREE/BASIC/entitlement logic was changed, consistent with the brief's Section 20 ("Do NOT change entitlement rules... unless the research document explicitly requires it" — it does not, and the sub-phase never reached the point where entitlement placement would need deciding).

## 21. Tests

None added. No test suite change.

## 22. Real Postgres verification

Not applicable — no schema or persistence code exists to verify.

## 23. Live Okendo verification

**Not performed for collection purposes.** The only live requests made this sub-phase were the two read-only checks described in Section 2 above (`api.okendo.io/robots.txt`, and re-fetching `docs.okendo.io/on-site/storefront-rest-api`), made solely to inform the commercial-use gate decision, not to collect or persist review data. No review data was collected, stored, or displayed. No store was crawled beyond these two read-only, non-destructive checks against Okendo's own infrastructure (not a Shopify store).

## 24. Vendor failure verification

Not applicable — no collector exists to test failure handling against.

## 25. Performance/EXPLAIN results

Not applicable — no query exists to analyze.

## 26. Bugs found

None — no code was written.

## 27. Bugs fixed

None applicable.

## 28. Known limitations

- This report's ToS analysis is a plain reading by an AI agent, not a legal opinion, and is explicitly flagged as such (Section 2).
- The Sub-phase A research document's own Section 33 "Unknowns" (Okendo's real rate limit, exact semantics of `isVerified`/`isIncentivized`, adoption share, JSON-LD adoption rate, etc.) remain entirely unresolved, since no further research toward implementation was performed once the gate check produced a STOP.
- The other four providers (Judge.me, Stamped, Yotpo, Loox) were not re-examined this sub-phase; their own research-required status from Sub-phase A stands unchanged.

## 29. Unverified items

Everything under "if the gate clears" (Sections 8–21 above) is unverified because it was never built, not because it was built and left unchecked.

## 30. STOP conditions

**Triggered: STOP condition 1** ("Okendo commercial-use rights cannot be established sufficiently") and plausibly **STOP condition 3** ("The endpoint's terms prohibit our intended commercial use"), per the brief's Section 28. See Section 2 above for the full evidentiary basis. No other STOP condition was reached, since implementation never proceeded far enough to test the others (SSRF exceptions, browser automation, Fable redesign, new infrastructure — none of these were ever approached).

## 31. Security review

Not applicable in the code sense — no code was written to review. The one relevant security-adjacent observation is negative-by-omission and already covered in Section 2: `api.okendo.io` returning a blanket 403 on `robots.txt` is a weak signal that this host is not configured as an intentionally open public interface, which is a data point for the ToS analysis rather than a code security finding.

## 32. Final recommendation

**Do not implement the Okendo collector under this sub-phase's scope.** The commercial-use gate is not cleared, and — unlike Sub-phase A's framing of it as merely "unknown" — this sub-phase found specific, adverse contractual language. Proceeding to build the collector without resolving Section 2's three options first would mean shipping a commercial product feature built on a data-access method that Okendo's own terms, plainly read, appear to prohibit — a direct violation of this project's own stated engineering discipline against workarounds and of the brief's explicit Section 1 instruction not to treat "public and unauthenticated" as equivalent to "commercially licensed."

## 33. Exact next-step recommendation

1. **A human/business decision is required** on which of Section 2's three paths (seek Okendo's permission, obtain real legal review, or abandon Okendo as a source) to pursue. This agent should not be asked to pick one, since all three are business/legal judgment calls outside engineering scope.
2. If path 1 or 2 is chosen and resolves favorably: re-open a Sub-phase B with the gate marked cleared, at which point Sections 3–35 of the original Sub-phase B brief (provider abstraction, collector, schema, scheduler integration, UI, tests) can proceed largely as specified, since none of the technical research or design work in Sub-phase A needs to be redone — only Phase 1 (this gate check) needed re-verification, and it is now done, with a documented, adverse result.
3. If path 3 is chosen: Milestone 9 likely closes without a shipped review-intelligence feature, or restarts provider evaluation from Judge.me/Stamped/Yotpo/Loox — each of which, per Sub-phase A's own research, has its own separate and generally harder-to-clear auth barrier, and each would need this identical commercial-use gate check repeated once (if ever) a technical path is found.
4. Regardless of path, this report and Sub-phase A's research document together should be treated as the durable record of why Okendo was not built in this pass — future sessions should read Section 2 of this report before re-attempting an Okendo integration, so the ToS finding is not silently forgotten and re-litigated from scratch.

Per the brief's Section 30 ("Final Verification Rule"): this sub-phase is explicitly **not** labeled complete. It is labeled **BLOCKED**, with the blocker being the commercial-use gate documented in Section 2, exactly as the brief's own protocol requires when the gate is not cleared.
