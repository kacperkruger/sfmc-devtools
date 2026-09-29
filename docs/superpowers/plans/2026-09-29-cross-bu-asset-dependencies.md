# Cross-Business-Unit Asset Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy assets referencing accessible shared Content Builder assets by key, full folder/name, or ID, regardless of the dependency's owning BU.

**Architecture:** Check the existing local/package reference cache first. On the first missing reference, fetch assets shared with the deploying BU once and retry. Keep these shared assets in a separate list used only as a lookup fallback, never in the general cache that selects create/update targets.

**Tech Stack:** JavaScript ES modules, Node.js, sfmc-sdk REST/SOAP, Mocha/Chai, axios-mock-adapter, mock-fs.

**Spec:** The user-provided bug report; requirements and investigation evidence are recorded below so this plan is self-contained.

## Requirements and boundaries

- Resolve `ContentBlockByKey`, `ContentBlockByName`, and `ContentBlockById` against assets accessible through sharing with the deploying BU.
- Support AMPscript and the existing SSJS `Platform.Function` forms.
- Preserve local dependency resolution, same-package ordering, and rejection of genuinely missing dependencies.
- Resolve existing literal references; changing the parser's support for variables, optional arguments, or additional identifier characters is outside this fix.
- Shared dependencies are reference targets; discovering them does not authorize copying or updating them.
- The initial investigation was followed by user-authorized implementation; see execution results below.

## Global Constraints

- Use the deploying BU's authenticated client; do not query arbitrary owner BUs or require additional owner credentials.
- No new runtime dependency or change to the default behavior of `Asset.retrieveForCache`.
- Do not merge shared dependency records into `cache.getCache().asset` during deployment.
- Do not modify source content merely to validate references.
- An API access/error response must not be reported as proof that a dependency does not exist.

## Root cause and evidence

1. `lib/Deployer.js:349` calls `retrieveForCache(null, subTypeArr)` while preparing deployment. `lib/metadataTypes/Asset.js:131` defaults `loadShared` to `false`. Consequently, `requestSubType` uses `/asset/v1/content/assets/query` without `?scope=shared` (`Asset.js:412`).
2. `Asset.upsert` (`Asset.js:283`) indexes only `cache.getCache().asset` and the deployment package. Its call to `ReplaceCbReference.createCache(..., true)` is commented out. Shared dependencies absent from the package therefore never enter the reference index.
3. `ReplaceContentBlockReference.#getAssetBy` in `lib/util/replaceContentBlockReference.js` consults only the in-memory `key`, `name`, and `id` maps. It performs no remote fallback. `replaceReference` throws a synthetic code-404 error during dependency discovery when a literal cannot be found.
4. `Asset._getUpsertOrderAndSkipMissing` (`Asset.js:208`) catches that error and skips the consumer with “not found on BU nor in deployment package.” This is a pre-upload rejection, not evidence of a Salesforce write failure.
5. The working reference-conversion path, `ReplaceContentBlockReference._retrieveCache`, already fetches shared assets with the fourth `retrieveForCache` argument set to `true`, normalizes their folder paths, and deliberately keeps them outside the general asset cache. Asset retrieval also contains explicit local/shared cache passes; deployment does not enter that retrieval-to-disk branch.
6. Name references have an additional requirement: `createCacheForMap` builds the index from `r__folder_Path` plus the asset name, using backslashes. Raw query records contain `category`; deployment's indexing path does not call `Asset.setFolderPath`. Merely retrieving shared records fixes key/ID visibility but is insufficient for names without folder normalization.
7. The general asset cache drives `MetadataType.createOrUpdate` (`lib/metadataTypes/MetadataType.js:1046`). Blindly merging shared records into it could turn a package item into an update against an asset owned elsewhere.

### Verification performed

- Ran `node_modules/.bin/mocha test/type.asset.test.js --grep 'via CBBK' --reporter dot`: **3 passing** (existing local dependency, missing dependency, and same-package dependency).
- Ran a disposable in-process assertion experiment with the production resolver. A foreign-owned asset (`memberId: 1111111`, deploying MID `9999999`) was absent from the local index: key, full folder/name, and ID each threw code 404. Adding the shared record after `Asset.setFolderPath` made all three resolve to the correct customer key. Indexing the raw record without normalizing its folder still failed the name lookup.
- The standalone experiment must initialize through `await import('./lib/index.js')` before dynamically importing the metadata classes; direct Asset imports hit an existing circular-module initialization error.
- No authenticated cross-BU deployment was performed. Shared query response shape, visibility, and runtime rendering remain sandbox validation gates, not claims established by this experiment.

### Test infrastructure gap

`test/resourceFactory.js:350` handles asset queries through a dynamic pool. It currently matches the query URL with or without query parameters but does not filter records by shared scope or target BU. A shared dependency fixture must not also appear in the local response, or the regression test can pass without fixing deployment. Its projection also omits ownership metadata; supply realistic fields where needed.

### Related observations, outside the core fix

- The reference index is static. `resetCacheMap` is currently called by tests, but not by production code; reset it at the start of each asset upsert to avoid stale references across BUs/deployments.
- The `r__asset_key` precheck uses `metadataMap[key]` instead of `metadataMap[metaKey]`, making that condition true for the current consumer. This is a separate structured-reference validation defect; track separately rather than treating the ContentBlock fix as coverage for it.
- `Asset.setFolderPath` has owner/current-BU fallback logic. Folder visibility and collisions need explicit tests, especially for sibling-owned assets; do not infer a path from an unrelated same-named folder.

## Review Focus

- A shared fixture accidentally returned by the local query masks the defect (Task 1).
- An earlier deployment's reference index leaks access across BUs (Task 2).
- A shared key/name collision selects an unintended write target or dependency (Task 2).
- A shared name lacks a resolvable folder path, while key/ID remain usable (Tasks 2–3).
- Shared-query pagination or errors produce partial/false “missing dependency” results (Tasks 1–3).

## File map

- Modify `lib/metadataTypes/Asset.js`: prepare dependency references before ordering; preserve general cache ownership boundaries.
- Modify `lib/util/replaceContentBlockReference.js` only if needed to expose deterministic fallback indexing; reuse existing index/reset methods where sufficient.
- Modify `test/resourceFactory.js`: represent local versus shared visibility explicitly for asset queries.
- Add `test/type.asset-shared.test.js`: cross-BU deployment regressions and isolation checks. Update intentional extra request counts in `test/type.asset.test.js` and `test/general.test.js`.
- Construct isolated per-case fixtures in mock-fs using existing consumer files; include foreign ownership, shared folder metadata, and key/name/ID variants without changing unrelated test fixtures.
- Modify `lib/metadataTypes/Folder.js` or `Asset.setFolderPath` only if the folder-specific tests demonstrate a gap; limit any repair to resolving visible shared categories/owner identity.
- Regenerate affected `@types` declarations with the repository type-generation command if adding methods.

## Task 1: Establish an honest failing cross-BU regression

**Interfaces:** The mock query handler consumes `URL.searchParams.get('scope')` and fixture visibility. Proposed fixture entry field: `queryScope: 'local' | 'shared'`; an absent field preserves legacy fixture behavior; the new cross-BU tests explicitly mark all existing fixtures local. Shared-only records must never appear in local queries. Tests may supply target-specific mock responses for different BUs.

- [x] Extend the mock handler and add fixtures: owner MID differs from deploy MID; dependency `shared-block-key`/ID `7001` exists only in the shared response and is absent from disk. Provide a real shared folder path, e.g. `Shared Content/Blocks`, and name `SharedBlock`.
- [x] Add parameterized deployment tests for key, full path/name, and ID, in AMPscript and SSJS. Assert one consumer deployed, a shared-scope request made with the target BU context, no dependency POST/PATCH, and no code-reference rewrite.
- [x] Add a mock-contract assertion that local requests cannot see `shared-block-key`. Exercise shared pagination with explicit paged responses (dependency only on page two) rather than relying on the current unpaginated dynamic pool.
- [x] Run `node_modules/.bin/mocha test/type.asset.test.js --grep 'cross-BU' --reporter spec`. Expect consumer-deployment assertions to fail on current production code because no shared query/index population occurs.
- [ ] Commit the isolated fixtures and failing regression tests as `test: reproduce shared asset dependency deployment failures`.

## Task 2: Prepare a complete, isolated deployment reference index

**Interfaces:** Add `Asset._prepareDeployReferenceCache(metadataMap: AssetMap): Promise<void>`. It consumes the already loaded target asset/folder caches and `this.client`/`this.buObject`; it populates `ReplaceCbReference.assetCacheMap` without mutating the general asset cache or package. `Asset.upsert` awaits it before `_getUpsertOrderAndSkipMissing`. Add `Asset._retrieveSharedDependencyItems(): Promise<AssetItem[]>` using `this.requestSubType(this.definition.crosslinkedSubTypes, null, null, null, true)` so duplicate keys can be inspected before map conversion.

- [x] Add focused tests: local query records with `category` resolve by full name; shared records resolve by key/name/ID; missing folder data does not prevent key/ID lookup; preparing BU B after BU A cannot retain an A-only dependency.
- [x] Add collision tests: local server records retain precedence over package records for existing IDs; package key/name entries retain precedence over shared fallback entries. ID lookup remains exact. Two different shared IDs claiming the same key/full name must produce an explicit ambiguity diagnostic rather than silently selecting an arbitrary dependency. Fail only consumers that reference an ambiguous shared alias, with the conflicting identifier and IDs; exact-ID references remain valid. Duplicate appearances of the same asset ID are harmless and should be deduplicated.
- [x] Implement `_prepareDeployReferenceCache`: reset the reference index; clone and normalize local records; index local records and package records; fetch raw shared records with `_retrieveSharedDependencyItems()` using the existing shared-scope/pagination implementation; clone/normalize and index shared fallback records. Preserve exact-ID entries and detect ambiguous shared aliases before collapsing them into a key map; if the API returns duplicate customer keys, detection must occur on response items before `parseResponseBody` overwrites them. Keep ambiguity handling limited to the new shared dependency path.
- [x] Reuse folders already cached by deployment (`folder-asset`, `folder-asset-shared`, `folder-cloudpages`). Verify owner/category identity in folder tests. If accessible shared category ancestry is missing, extend target-context folder retrieval narrowly and derive paths from returned ancestry; do not query unrestricted owner BUs or fabricate paths.
- [x] Propagate shared-query failures with BU/scope context and abort asset preflight before writes. Do not convert network/authorization errors into an empty successful shared response.
- [x] Keep discovered shared dependencies out of `metadataMap` and `cache.getCache().asset`. Existing topological sorting already excludes nodes absent from the deployment package. Do not uncomment `createCache(..., true)`: that helper reloads disk metadata and replaces the general asset/folder caches.
- [x] Run the Task 1 regressions plus isolation/collision tests; expect all to pass. Verify the query occurs once per upsert preparation (with normal subtype chunks/pages), not once per consumer/reference.
- [ ] Commit as `fix: resolve shared asset references during deployment`.

## Task 3: Complete validation and compatibility coverage

**Interfaces:** Use the same `handler.deploy` entry point as existing tests. Assert returned deployed keys, API request bodies/history, and unchanged general asset-cache contents.

- [x] Cover a dependency shared to the target, not shared to the target, and access revoked between two deployments. Accessible references succeed; unavailable ones skip the consumer with an accurate diagnostic. Cover parent-owned and sibling-owned shared dependencies with realistic folder responses.
- [x] Cover empty shared results, shared-query 403/500, a missing shared folder, duplicate asset names in different folders, repeated references, and shared dependencies mixed with local/same-package dependencies. Check SSJS escaped backslashes. A folder failure must identify the unresolved path rather than invent a name match.
- [x] Assert a shared-only dependency is never written/downloaded as part of deployment and never causes an update-target match. Test a package key colliding with a shared asset: no PATCH to the shared asset ID.
- [x] Update exact request-count expectations for the intentional additional shared query. Run `node_modules/.bin/mocha test/type.asset.test.js --reporter dot`, then `npm test`, `npm run lint`, and `npm run lint-ts`; expect zero failures and review generated declarations for intended changes only.
- [ ] In a sandbox, create a block in BU A and share it to BU B; use a third BU C without access. Deploy consumers from B by key, path/name, and ID in AMPscript and SSJS; verify successful deployment and rendered content. Repeat with a sibling owner, read-only sharing, a dependency on a later query page, and revoked access. Confirm the shared original is unchanged and C remains unable to resolve it.
- [ ] Explicitly validate Salesforce's name-reference restriction: SSJS `ContentBlockByName` works with shared content only through a shared folder. An individually shared asset's API visibility alone does not establish name-reference runtime support. Test this configuration separately and document the supported behavior; do not silently rewrite references to another function.
- [ ] Record sandbox evidence and any tenant-specific response differences, then commit final regression coverage/documentation as `test: validate cross-BU asset reference isolation`.

## Acceptance criteria

All three supported literal reference forms deploy when the dependency is accessible to the target BU (with valid shared-folder semantics for names). Missing/inaccessible dependencies remain rejected, shared retrieval failures are distinguished from absence, no foreign dependency becomes a write target, local/same-package behavior remains correct, and sequential deployments cannot inherit another BU's dependency visibility.

## External reference

Salesforce documents the shared-folder requirement for SSJS name references in [ContentBlockByName](https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/ssjs_platformContentContentBlockByName.html). Sharing concepts are described in [Sharing](https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/sharing). The proposed shared-query endpoint is already implemented in this repository; live target-BU behavior still requires the sandbox validation above.

## Execution results (2026-09-29)

Implemented in the existing checkout. Git worktree creation was denied by the read-only `.git` sandbox; changes remain uncommitted. No live Salesforce credentials were present, so sandbox deployment/rendering steps above remain outstanding.

- Added 29 cross-BU tests; the initial six AMPscript/SSJS key/name/ID deployment regressions failed before the production fix.
- Asset-specific verification: 55 passing (29 new, 26 existing).
- Full verification: `XDG_CONFIG_HOME=/tmp/devtools-cross-bu-config npm test` with subprocess permission: 531 passing, 16 pending. The initial restricted baseline had eight environment-related failures; they disappear with this test environment.
- `npm run lint` and `npm run lint-ts` pass. Generated the affected declarations with `tsc -p tsconfig.json --lib es2024,esnext.array --outDir tmp/cross-bu-assets/generated-types` and copied only the two affected declaration pairs. Isolated output avoids the existing TS5055 input/output overlap, and the library flags match the existing lint-ts configuration.
- Independent review found three important issues, each reproduced before fixing: shared ID/customer-key collisions causing false topology cycles; rejected consumers reintroduced via another package dependency; wrong-owner folder fallbacks producing invalid name aliases. All have regression tests.

Implementation refinements:

1. Ambiguity is checked when a shared key/name is referenced, rather than blocking an entire deployment for an unrelated duplicate. Local/package aliases retain precedence and exact shared IDs remain usable.
2. Shared-only ID references are excluded from deployment ordering via an optional flag; reference discovery outside deployment keeps its existing semantics. Locally indexed IDs returned again by shared scope retain normal package ordering.
3. Rejected package assets and their dependent assets stay excluded from the final deployment order.
4. Strict folder ownership is required for shared dependency names. Other retrieval workflows keep their fallback behavior; key/ID lookup still works when a shared folder cannot be verified.
5. New scoped mock fixtures are strict; historical untagged fixtures preserve their prior behavior. Tests live in a separate file and build per-case fixtures in mock-fs.

Parser expansion, the pre-existing structured `r__asset_key` precheck defect, folder retrieval's general ID deduplication, and standalone reference-conversion lifecycle changes are outside this deployment fix. Live sharing visibility and rendering semantics remain subject to the sandbox checklist above. There are no deferred code-review minor findings.

## Simplification requested by the user

The initial implementation was simplified to cache-first resolution:

1. `_prepareDeployReferenceCache` indexes only local and packaged assets.
2. A missing reference triggers `_cacheSharedAssets` once per deployment and retries validation. Shared-query failures abort before asset writes; successful empty results are cached for the remainder of the deployment.
3. `ReplaceContentBlockReference.#getAssetBy` looks in the normal cache, then the shared list. A shared match is already deployed, so it adds no package-ordering edge.

Removed the separate shared-ID set, ambiguity maps, shared index-building method, and optional lookup flags. Ambiguity is checked directly against shared matches. The folder-ownership and rejected-dependency fixes remain covered. Standalone reference-cache creation resets the shared fallback to prevent stale state crossing commands.

Added a regression proving local-only references make no shared requests. The current verification is **532 passing, 16 pending**, including **56 asset tests**; lint and type checks pass. Earlier eager-loading method names and request-count changes in this plan describe the superseded design.
