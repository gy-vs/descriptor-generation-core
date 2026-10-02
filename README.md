# Protocol Buffers Core

Run `npm install`, then `npm test`.

## Descriptor pool

`DescriptorPool` registers `.proto` files in any order, tracks their
dependencies, and links them into immutable descriptor graphs.

### Startup / pending files

- `addFile(node)` declares a file and links it (plus anything waiting on it)
  as dependencies arrive. Files whose dependencies are missing stay pending.
- `replaceFile(node)` swaps a **pending** file. Published (linked) files are
  frozen and cannot be replaced through this API.

### Atomic revisions of a running pool

Updating files already in service must not expose a half-merged set of
definitions, and code holding old descriptors must keep working. The
revision API stages and publishes a whole new generation:

```ts
const revision = pool.prepareRevision([commonV2, baseV2, apiV2]);

if (!revision.ok) {
  for (const error of revision.errors) {
    // error.revisionFile — the submitted file responsible
    // error.failedFile   — where the concrete failure was detected
    // error.cause        — DuplicateSymbolError / SymbolLookupError / ...
  }
  // Nothing was published; the live pool is untouched. Fix and retry.
} else {
  const report = revision.commit();   // single atomic hand-over
  // report.generationId / publishedFiles / pendingFiles / unchangedFiles
}
```

Properties of the hand-over:

- **Atomic visibility.** Staging builds a candidate generation off to the
  side; queries keep returning the live descriptors until `commit()`
  repoints the pool in one step. Duplicate symbols, invisible references,
  wrong-kind references, bad extension ranges and dependency cycles all
  reject the revision before publication — there is no window where one
  file is new and its dependents still parse against old symbols.
- **Whole-closure coherence.** Every file that imports a revised file —
  whether or not it is itself in the batch — is rebuilt in the candidate,
  so a message that stays queryable never internally points at a
  superseded symbol table. Unrelated files keep their descriptor
  identity (`unchangedFiles` in the report).
- **Old references stay valid.** Descriptors captured earlier are frozen
  objects belonging to the old generation and keep resolving one another;
  an in-flight RPC holding a method descriptor keeps reading its old
  input/output types. Later pool queries return the new generation.
- **Error attribution.** Each failure names the submitted file
  responsible (`revisionFile`), even when the concrete error is detected
  in an unrevised dependent.
- **Order independent.** A batch publishes the same generation (and the
  same failure set when rejected) regardless of file order.
- **Pending semantics preserved.** Files missing dependencies remain
  pending in the new generation; `addFile` / `replaceFile` keep working
  after a commit. A revision prepared against a superseded generation
  fails with `RevisionStaleError` on commit — prepare again.

`pool.commitRevision(batch)` combines prepare + commit for callers that do
not need to inspect a failed candidate.
