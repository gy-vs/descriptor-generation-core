# Protocol Buffers Core

Run `npm install`, then `npm test`.

## Descriptor pool

`DescriptorPool` registers `.proto` files in any order, tracks dependencies,
and links them into immutable descriptor graphs.

### Incremental registration (unchanged)

- `addFile(node)` — register a file; it links once every dependency is
  available, cascading to waiting dependents. Returns the
  `FileDescriptor` or `null` while pending.
- `replaceFile(node)` — swap a **pending** revision. Published files are
  frozen and cannot be replaced this way.
- Symbol/visibility/cycle errors name the offending file; failed files stay
  pending with the error available via `fileError(name)`.

### Atomic hot revisions

Published descriptors are immutable and long-lived callers may hold them
indefinitely, so revisions of in-use files cannot be applied one by one.
Submit a batch of related file revisions as one candidate generation:

```ts
// 1. Validate the whole set without affecting any live query.
const revision = pool.prepareRevision([commonV2, serviceV2, messageV2]);

if (!revision.ok) {
  // revision.failures: [{ file, error }, ...] — every file that prevents
  // publication, in deterministic order. The live pool is untouched.
  for (const f of revision.failures) console.error(f.file, f.error);
  return;
}

// Inspect the candidate world if needed (frozen descriptors, new objects).
revision.findMessageTypeByName('pkg.Msg');
revision.getFileDescriptor('service.proto');

// 2. Publish atomically (throws RevisionStaleError if the pool advanced
//    after prepare — prepare again).
const result = pool.commitRevision(revision);
// result.generation, result.updatedFiles
```

`commitRevisionOf(batch)` is the prepare-then-commit shorthand.

Properties of a committed revision:

- **Atomicity / completeness.** The batch plus every transitive dependent
  of a changed file is rebuilt into the same candidate world. Half-old /
  half-new states are never observable; validation covers duplicate symbols,
  invisible (non-imported) references, import cycles, missing non-weak
  dependencies, wrong symbol kinds and extension ranges.
- **Failure isolation.** A failed preparation changes nothing: live queries
  keep returning the old descriptors and unrelated files stay available.
  Correct the files and prepare again.
- **Old references keep working.** Commit builds fresh descriptor objects
  for the rebuilt closure and never mutates the old ones. Callers holding
  old messages/methods continue to see the old, internally consistent graph;
  subsequent pool lookups of the same fully-qualified name return the new
  generation. Files outside the rebuild closure keep their exact descriptor
  objects.
- **Order independence.** Batch ordering never changes the published result.
- **Pending semantics preserved.** Out-of-order registration and
  `replaceFile` continue to work exactly as before, including after
  commits; still-pending files cannot be part of a revision batch (use
  `replaceFile`). After a commit, previously failed pending files retry
  against the new generation.
- `generationId` identifies the generation currently being served.
