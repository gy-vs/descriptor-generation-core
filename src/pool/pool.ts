import type{FileNode}from'./ast.js';
import type{
  EnumDescriptor,
  EnumValueDescriptor,
  FieldDescriptor,
  FileDescriptor,
  MessageDescriptor,
  ServiceDescriptor,
}from'./descriptor.js';
import{Generation}from'./generation.js';
import{DescriptorError,FrozenDescriptorError}from'./errors.js';
import type{Symbol}from'./symbols.js';
import{Revision,buildCandidate}from'./revision.js';
import type{CommitReport,RevisionHost}from'./revision.js';

/**
 * A descriptor pool: registers `.proto` files (in any order), tracks their
 * dependencies, links them into immutable descriptor graphs, and supports
 * atomic multi-file revisions of a running generation.
 *
 * Incremental registration (the startup / pending-file API):
 *
 *  - `addFile` declares a file's symbols and links it (plus anything
 *    waiting on it) as soon as its dependencies are available. Files with
 *    missing dependencies stay pending; a pending file may be swapped with
 *    `replaceFile`. These semantics are unchanged from the very first
 *    generation — pending-file handling is not altered by hot updates.
 *
 * Generational updates (the running-service API):
 *
 *  - `prepareRevision(files)` stages a *complete* new generation off to the
 *    side: the submitted files and every file that depends on them are
 *    rebuilt as one unit, while untouched files keep their frozen
 *    descriptors. Nothing the live queries return changes during staging.
 *  - The returned {@link Revision} says whether the candidate is
 *    publishable (`ok`) and, if not, which submitted file is responsible
 *    (`revisionFile`) for each failure. `Revision.commit()` is the single
 *    hand-over point: it either repoints every subsequent query at the new
 *    generation or throws without touching the live one.
 *
 * Descriptors captured before a successful commit are never modified: they
 * belong to the old generation and keep resolving one another. The same
 * fully-qualified name queried after the commit resolves against the new
 * symbol table. Old generations stay alive as long as their descriptors
 * are referenced; the pool simply no longer answers through them.
 */
export class DescriptorPool implements RevisionHost{
  private gen=new Generation();
  /** Bumped whenever the live generation changes structure (a new
   *  registration actually lands or a revision commits). Prepared
   *  revisions compare against it to detect that they went stale. */
  private version=0;
  private nextGenerationId=1;

  constructor(){
    this.gen.id=this.nextGenerationId++;
  }

  // ------------------------------------------------------------------
  // Incremental mutation (first-generation semantics)
  // ------------------------------------------------------------------

  /**
   * Register a file and link it (plus anything waiting on it) once its
   * dependencies are available. Returns the published FileDescriptor, or
   * null while the file is pending.
   *
   * Throws the first error produced by the link cascade this call
   * triggers (which may belong to a previously pending file that this
   * file unblocks). Adding the same file contents twice is a no-op.
   * Adding different contents under an existing name throws
   * DuplicateFileError — use `replaceFile` for pending revisions, or
   * `prepareRevision` to revise published files atomically.
   */
  addFile(node:FileNode):FileDescriptor|null{
    // A successful add may also link previously-pending files via the
    // cascade; an identical re-add changes nothing. Compare the set of
    // published files to decide whether the structure version moves.
    const linkedBefore=countLinked(this.gen);
    const hadEntry=this.gen.files.has(node.name);
    try{
      return this.gen.register(node).descriptor;
    }finally{
      const linkedAfter=countLinked(this.gen);
      if(!hadEntry&&this.gen.files.has(node.name)||linkedAfter!==linkedBefore)this.bump();
    }
  }

  /**
   * Replace a pending file with a new revision and re-run linking. Only
   * pending files can be replaced: a published FileDescriptor is immutable,
   * so replacing a linked file throws FrozenDescriptorError. Replacing an
   * unknown name is equivalent to `addFile`.
   *
   * The old revision is withdrawn first; if the new revision fails to
   * register (e.g. duplicate symbols), the file is left unregistered and
   * its dependents keep waiting.
   */
  replaceFile(node:FileNode):FileDescriptor|null{
    const existing=this.gen.files.get(node.name);
    if(existing?.status==='linked')throw new FrozenDescriptorError();
    let result:FileDescriptor|null=null;
    let changed=false;
    try{
      result=this.gen.replace(node);
      changed=true;
      return result;
    }finally{
      if(changed)this.bump();
    }
  }

  // ------------------------------------------------------------------
  // Atomic multi-file revisions
  // ------------------------------------------------------------------

  /**
   * Stage a batch of interdependent file revisions as one candidate
   * generation, without changing any answer this pool currently gives.
   *
   * The batch is validated and linked as a unit: duplicate symbols,
   * invisible references, wrong-kind references, bad extension ranges and
   * dependency cycles introduced by the batch all fail the revision, and
   * the live generation keeps serving its previous descriptors. Each
   * {@link RevisionFileError} names the submitted file responsible
   * (`revisionFile`), so the batch can be fixed and retried.
   *
   * Files that import a revised file — whether or not they are themselves
   * in the batch — are rebuilt in the candidate so the new generation
   * never exposes an object whose fields point at a superseded symbol
   * table. Files outside that closure keep descriptor identity.
   *
   * Files still missing dependencies stay pending in the candidate,
   * exactly as in the live pool; pending does not reject a revision.
   */
  prepareRevision(batch:FileNode[]):Revision{
    const built=buildCandidate(this.gen,batch);
    return new Revision(
      this,
      this.version,
      this.gen.id,
      batch.map(n=>n.name),
      built.unchangedFiles,
      built.candidate,
      built.changedNames,
      built.errors,
    );
  }

  /**
   * Convenience: prepare a revision and commit it in one call. Returns the
   * commit report on success; throws RevisionRejectedError (live pool
   * untouched) when the batch cannot publish. Prefer `prepareRevision`
   * when the caller needs to inspect a failed revision before retrying.
   */
  commitRevision(batch:FileNode[]):CommitReport{
    return this.prepareRevision(batch).commit();
  }

  /** @internal RevisionHost: structure version guard. */
  currentVersion():number{return this.version}

  /** @internal RevisionHost. */
  currentGenerationId():number{return this.gen.id}

  /** @internal RevisionHost: atomic hand-over. */
  activate(candidate:Generation):{generationId:number}{
    candidate.id=this.nextGenerationId++;
    this.gen=candidate;
    this.bump();
    return{generationId:candidate.id};
  }

  private bump():void{this.version++}

  /** Monotonic id of the generation currently serving queries. */
  get generationId():number{return this.gen.id}

  /** Structure version; changes with any live registration or commit. */
  get poolVersion():number{return this.version}

  // ------------------------------------------------------------------
  // Queries (all served by the live generation)
  // ------------------------------------------------------------------

  /** The published descriptor for a linked file, else null. */
  getFileDescriptor(name:string):FileDescriptor|null{
    return this.gen.getFileDescriptor(name);
  }

  isLinked(name:string):boolean{return this.gen.isLinked(name)}
  isPending(name:string):boolean{return this.gen.isPending(name)}
  isRegistered(name:string):boolean{return this.gen.isRegistered(name)}

  /** Names of non-weak dependencies this file is still waiting for. */
  missingDependenciesOf(name:string):string[]{
    return this.gen.missingDependenciesOf(name);
  }

  /** Weak dependencies that were absent when the file was linked. */
  missingWeakDependenciesOf(name:string):string[]{
    return this.gen.missingWeakDependenciesOf(name);
  }

  /** The error from the last failed link attempt of a file, if any. */
  fileError(name:string):DescriptorError|null{
    return this.gen.fileError(name);
  }

  pendingFiles():string[]{return this.gen.pendingFiles()}
  linkedFiles():string[]{return this.gen.linkedFiles()}

  /** Look up any symbol by fully-qualified name (leading dot optional). */
  findSymbol(fullName:string):Symbol|null{
    return this.gen.findSymbol(fullName);
  }

  findMessageTypeByName(fullName:string):MessageDescriptor|null{
    return this.gen.findMessageTypeByName(fullName);
  }

  findEnumByName(fullName:string):EnumDescriptor|null{
    return this.gen.findEnumByName(fullName);
  }

  findEnumValueByName(fullName:string):EnumValueDescriptor|null{
    return this.gen.findEnumValueByName(fullName);
  }

  findServiceByName(fullName:string):ServiceDescriptor|null{
    return this.gen.findServiceByName(fullName);
  }

  findFieldByName(fullName:string):FieldDescriptor|null{
    return this.gen.findFieldByName(fullName);
  }

  findExtensionByName(fullName:string):FieldDescriptor|null{
    return this.gen.findExtensionByName(fullName);
  }
}

function countLinked(gen:Generation):number{
  let n=0;
  for(const entry of gen.files.values())if(entry.status==='linked')n++;
  return n;
}
