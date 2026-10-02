import type{FileNode}from'./ast.js';
import{
  DependencyCycleError,
  DescriptorError,
  RevisionFileError,
  RevisionRejectedError,
  RevisionStaleError,
}from'./errors.js';
import{
  Generation,
  addToSetMap,
  findCycle,
  hashNode,
  removeFromSetMap,
}from'./generation.js';

/**
 * Atomic, cross-file revisions of a live descriptor pool.
 *
 * A revision is prepared against a live {@link Generation}: the proposed
 * file nodes are merged into a *candidate* generation, which is rebuilt for
 * every file that could possibly change — every file in the revision plus
 * its whole reverse-dependency closure. Files outside that closure keep
 * their published descriptor objects verbatim. The candidate is fully
 * declared and linked before anything is published: any failure leaves the
 * live generation untouched. `Revision.commit()` performs the hand-over in
 * one step — the pool's query root is repointed at the candidate — so
 * users of the old, frozen descriptor graphs never observe a half-merged
 * symbol table, while subsequent queries see the complete new generation.
 */

/** Result of a successful, atomic revision commit. */
export interface CommitReport{
  /** Id of the generation now serving the pool. */
  generationId:number;
  /** Submitted files whose new revision was published (linked). */
  publishedFiles:string[];
  /** Submitted files that exist in the new generation but are still
   *  waiting on dependencies. */
  pendingFiles:string[];
  /** Submitted files whose contents were already current; they were not
   *  rebuilt and their descriptors kept their identity. */
  unchangedFiles:string[];
}

export interface RevisionHost{
  /** Pool structure version; changes whenever the live generation does. */
  currentVersion():number;
  currentGenerationId():number;
  /** Atomically install the candidate generation, assigning it an id. */
  activate(candidate:Generation):{generationId:number};
}

/**
 * A prepared revision: a complete candidate generation plus everything
 * needed to either publish it atomically or explain why it cannot be
 * published. Preparing never touches the live pool; committing a rejected
 * or stale revision throws without changing anything.
 */
export class Revision{
  /** Files submitted in this revision, in the order they were given. */
  readonly files:readonly string[];
  /** Submitted files whose contents are identical to the live ones;
   *  they were not rebuilt and keep their descriptor identity. */
  readonly unchangedFiles:readonly string[];
  /** Every per-file error that prevents publication, empty when `ok`. */
  readonly errors:readonly RevisionFileError[];
  /** Pool structure version this revision was prepared against. */
  readonly baseVersion:number;
  readonly baseGenerationId:number;

  private done=false;

  /** @internal */
  constructor(
    private readonly host:RevisionHost,
    baseVersion:number,
    baseGenerationId:number,
    fileNames:string[],
    unchangedFiles:string[],
    /** @internal Candidate generation; scratch until commit. */
    readonly candidate:Generation,
    /** Names the revision actually changes (drives the report). */
    private readonly changedNames:readonly string[],
    errors:RevisionFileError[],
  ){
    this.files=fileNames;
    this.unchangedFiles=unchangedFiles;
    this.errors=errors;
    this.baseVersion=baseVersion;
    this.baseGenerationId=baseGenerationId;
  }

  /** True when the candidate generation is complete and publishable. */
  get ok():boolean{return this.errors.length===0}

  /** True when committed, or when the pool moved on after preparation. */
  get isStale():boolean{
    return this.done||this.host.currentVersion()!==this.baseVersion;
  }

  /**
   * Publish the candidate generation atomically. Throws
   * RevisionRejectedError when the candidate has errors, and
   * RevisionStaleError when the pool accepted other registrations after
   * this revision was prepared (or the revision was already committed).
   * In every failure case the live generation is unchanged.
   */
  commit():CommitReport{
    if(this.done)throw new RevisionStaleError();
    if(this.host.currentVersion()!==this.baseVersion)throw new RevisionStaleError();
    if(this.errors.length>0)throw new RevisionRejectedError([...this.errors]);

    const{generationId}=this.host.activate(this.candidate);
    this.done=true;

    const published:string[]=[];
    const pending:string[]=[];
    for(const name of this.changedNames){
      const entry=this.candidate.files.get(name);
      if(!entry)continue;
      if(entry.status==='linked')published.push(name);
      else pending.push(name);
    }
    published.sort();
    pending.sort();
    return{
      generationId,
      publishedFiles:published,
      pendingFiles:pending,
      unchangedFiles:[...this.unchangedFiles].sort(),
    };
  }
}

interface BuiltCandidate{
  candidate:Generation;
  errors:RevisionFileError[];
  changedNames:string[];
  unchangedFiles:string[];
}

/**
 * Stage a candidate generation from `base` with `batch` merged in.
 *
 * Only the revised files and their transitive dependents are rebuilt;
 * everything else carries its frozen descriptors over unchanged. The
 * build follows fixed (name-sorted) orders, so the result is independent
 * of the batch's arrival order. Every failure detected on the candidate
 * is attributed to one of the submitted files.
 */
export function buildCandidate(base:Generation,batch:FileNode[]):BuiltCandidate{
  if(batch.length===0)
    throw new DescriptorError('a revision must contain at least one file');

  const errors:RevisionFileError[]=[];
  const pushError=(revisionFile:string,failedFile:string,cause:DescriptorError):void=>{
    errors.push(new RevisionFileError(revisionFile,failedFile,cause));
  };

  // --- Batch shape: one node per file name (later duplicates reported).
  const unique=new Map<string,FileNode>();
  const fileNames:string[]=[];
  for(const node of batch){
    fileNames.push(node.name);
    if(unique.has(node.name)){
      pushError(node.name,node.name,
        new DescriptorError(`file "${node.name}" appears more than once in the revision batch`));
      continue;
    }
    unique.set(node.name,node);
  }

  // --- Per-file structural validation before any graph work.
  for(const node of[...unique.values()].sort((a,b)=>a.name.localeCompare(b.name))){
    try{
      base.validateImportIndices(node);
    }catch(e){
      pushError(node.name,node.name,e as DescriptorError);
    }
  }

  // --- Split submitted files into content-revised and equal-hash ones.
  //     Whether an equal-hash file genuinely "keeps identity" is decided
  //     after the affected closure is known: one that depends (directly or
  //     transitively) on a revised file is rebuilt in the new generation
  //     and gets a new descriptor identity regardless.
  const equalHash:string[]=[];
  const changedNames:string[]=[];
  for(const[name,node]of unique){
    const existing=base.files.get(name);
    if(existing&&existing.hash===hashNode(node))equalHash.push(name);
    else changedNames.push(name);
  }
  changedNames.sort();

  // Invalid batches cannot produce a usable rebuild; the Revision rejects.
  if(errors.length>0)
    return{candidate:new Generation(),errors,changedNames,unchangedFiles:[]};

  const revised=new Set(changedNames);

  // --- Affected closure: revised files plus every transitive importer.
  //     Importers through any import (direct, public, weak) count: a
  //     weak importer that resolves a type from the revised file at link
  //     time must be rebuilt against the new definitions too. Submitting
  //     an equal-hash file never widens the closure: it changes nothing.
  const affected=new Set<string>(revised);
  const queue=[...revised];
  while(queue.length>0){
    for(const dependent of[...(base.dependents.get(queue.shift()!)??[])].sort()){
      if(!affected.has(dependent)){
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  // Submitted equal-hash files that the closure does not touch are true
  // no-ops: their descriptors are carried over with identity preserved.
  const unchangedFiles=equalHash.filter(n=>!affected.has(n)).sort();

  // --- Cycle check over the merged graph (revised nodes override).
  const allNames=new Set<string>(base.files.keys());
  for(const name of revised)allNames.add(name);
  const edgesOf=(name:string):readonly string[]=>
    unique.get(name)?.dependencies??base.files.get(name)?.node.dependencies??[];
  const cycle=findCycle(allNames,edgesOf);
  if(cycle){
    // A merged-graph cycle necessarily passes through a revised file.
    const blamed=cycle.filter(n=>revised.has(n)).sort()[0]??changedNames[0];
    pushError(blamed,blamed,new DependencyCycleError(cycle));
  }

  // --- Symbol table: copy the live one, withdraw symbols owned by
  //     revised files. Packages are shared namespace components and stay
  //     (revised files re-declare the same package components harmlessly).
  const stagedTable=base.table.clone();
  for(const symbol of stagedTable.all())
    if(symbol.kind!=='package'&&revised.has(symbol.file))
      stagedTable.delete(symbol.fullName);
  const candidate=new Generation(stagedTable);

  // --- Entries:
  //     unaffected files carry over as copies (status, descriptor and
  //     resolved targets untouched, so their published graph identity is
  //     preserved); affected files reset and are re-linked below.
  for(const[baseName,baseEntry]of base.files){
    if(affected.has(baseName)){
      candidate.files.set(baseName,{
        node:unique.get(baseName)??baseEntry.node,
        hash:unique.has(baseName)?hashNode(unique.get(baseName)!):baseEntry.hash,
        status:'pending',descriptor:null,
        // Unrevised affected files keep their declared symbol records;
        // re-linking simply re-binds the targets. Revised files redeclare.
        symbolNames:revised.has(baseName)?[]:[...baseEntry.symbolNames],
        pendingOn:new Set(),missingWeak:[],
        failed:false,lastError:null,rank:0,
      });
    }else{
      candidate.files.set(baseName,{
        ...baseEntry,
        pendingOn:new Set(baseEntry.pendingOn),
        missingWeak:[...baseEntry.missingWeak],
        symbolNames:[...baseEntry.symbolNames],
      });
    }
  }
  // New files (not present in the base generation).
  for(const name of revised){
    if(base.files.has(name))continue;
    candidate.files.set(name,{
      node:unique.get(name)!,hash:hashNode(unique.get(name)!),
      status:'pending',descriptor:null,symbolNames:[],
      pendingOn:new Set(),missingWeak:[],
      failed:false,lastError:null,rank:0,
    });
  }

  // --- Reverse-dependency graph of the merged file set.
  for(const entry of candidate.files.values())
    for(const depName of entry.node.dependencies)
      addToSetMap(candidate.dependents,depName,entry.node.name);

  // --- Declare revised files in a fixed name order, so declaration
  //     results (and duplicate-symbol attribution) are order independent.
  for(const name of[...revised].sort()){
    const entry=candidate.files.get(name)!;
    const created:string[]=[];
    try{
      candidate.declareSymbols(entry.node,created);
      entry.symbolNames=created;
    }catch(e){
      for(const createdName of created.reverse())candidate.table.delete(createdName);
      for(const depName of entry.node.dependencies)
        removeFromSetMap(candidate.dependents,depName,name);
      candidate.files.delete(name);
      pushError(name,name,e as DescriptorError);
    }
  }

  // --- pendingOn for every not-yet-linked entry.
  for(const entry of candidate.files.values()){
    if(entry.status==='linked')continue;
    entry.node.dependencies.forEach((depName,i)=>{
      if(entry.node.weakDependencies.includes(i))return;
      const dep=candidate.files.get(depName);
      if(!dep||dep.status!=='linked')entry.pendingOn.add(depName);
    });
  }

  // --- Link everything ready. Carried-over failures of unaffected files
  //     are pre-existing and are not blamed on this revision; failures
  //     inside the affected closure are attributed below.
  //
  //     An *unrevised* affected dependent that was already permanently
  //     failed in the base generation keeps failing here with the same
  //     error: that breakage predates the revision, so it is carried over
  //     (still pending with its error) rather than rejecting the commit.
  //     A revised file that fails, or a newly appearing failure, is the
  //     revision's responsibility.
  const sameFailure=(a:DescriptorError|null,b:DescriptorError|null):boolean=>
    !!a&&!!b&&a.name===b.name&&a.message===b.message;
  candidate.cascade();

  for(const entry of candidate.files.values()){
    if(!affected.has(entry.node.name)||!entry.failed||!entry.lastError)continue;
    if(!revised.has(entry.node.name)
      &&sameFailure(entry.lastError,base.files.get(entry.node.name)?.lastError??null))
      continue;
    const blamed=blameRevisionFile(candidate,entry.node.name,revised);
    if(blamed)pushError(blamed,entry.node.name,entry.lastError);
  }

  // Declaration/structural errors are pushed in batch order and cascade
  // failures in processing order; normalize so inspection and retries are
  // independent of how the batch happened to be arranged.
  errors.sort((a,b)=>
    a.revisionFile.localeCompare(b.revisionFile)
    ||a.failedFile.localeCompare(b.failedFile)
    ||a.message.localeCompare(b.message));

  return{candidate,errors,changedNames,unchangedFiles};
}

/** From the failed file, walk its dependency edges and return the closest
 *  revised file (breadth-first; ties broken lexicographically), or null
 *  when the failure is unrelated to the revision. The failed file itself
 *  always matches when it is one of the submitted files. */
function blameRevisionFile(gen:Generation,failedName:string,revised:Set<string>):string|null{
  if(revised.has(failedName))return failedName;
  const seen=new Set<string>([failedName]);
  let frontier:string[]=[failedName];
  while(frontier.length>0){
    const hits=frontier.filter(n=>revised.has(n)).sort();
    if(hits.length>0)return hits[0];
    const next:string[]=[];
    for(const name of frontier)
      for(const dep of gen.files.get(name)?.node.dependencies??[])
        if(!seen.has(dep)){seen.add(dep);next.push(dep)}
    frontier=next;
  }
  return null;
}
