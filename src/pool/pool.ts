import type{FileNode}from'./ast.js';
import{
  EnumDescriptor,
  EnumValueDescriptor,
  FieldDescriptor,
  FileDescriptor,
  MessageDescriptor,
  ServiceDescriptor,
}from'./descriptor.js';
import{
  DependencyCycleError,
  DescriptorError,
  DuplicateFileError,
  FrozenDescriptorError,
  MissingDependencyError,
  RevisionFailure,
  RevisionStaleError,
  RevisionValidationError,
}from'./errors.js';
import{
  LinkContext,
  SymbolDeclarer,
  declareSymbols,
  findCycle,
  linkFile,
  rankOf,
  transitiveDependents,
  validateImportIndices,
}from'./link.js';
import{PendingRevision}from'./revision.js';
import type{PlannedFile,RevisionPlan}from'./revision.js';
import{SymbolTable}from'./symbols.js';
import type{Symbol,SymbolKind}from'./symbols.js';

/**
 * A descriptor pool: registers `.proto` files (in any order), tracks their
 * dependencies, and links them into immutable descriptor graphs.
 *
 * Published descriptors live in an immutable **generation**: a symbol
 * table plus the linked file graph. The pool serves one generation at a
 * time; files still waiting on dependencies live in a separate pending
 * registry whose declarations overlay the current generation. When pending
 * files become linkable they are linked against the current generation and
 * a successor generation is installed atomically.
 *
 * Revisions of already-published files cannot be applied one by one (that
 * would publish an inconsistent half-old/half-new graph). Instead a batch
 * of file revisions is validated as one complete candidate world with
 * `prepareRevision` — every transitive dependent of a changed file is
 * rebuilt into the same candidate generation — and only published by
 * `commitRevision`. A failed preparation leaves the live generation, and
 * every descriptor handed out from it, completely untouched.
 *
 * Descriptor objects are never mutated after publication: a revision
 * produces fresh descriptor graphs for the rebuilt closure, while files
 * outside the closure keep their existing objects. Callers that hold old
 * references keep seeing the old, internally consistent generation; later
 * pool queries see the new one.
 *
 * Files with missing dependencies stay pending. A missing `weak` import
 * never blocks linking. A pending file may be replaced by a new revision
 * with `replaceFile`; a linked (published) file is immutable and cannot be
 * replaced outside of a committed revision.
 */

interface LinkedFile{
  node:FileNode;
  hash:string;
  descriptor:FileDescriptor;
  /** Non-package symbols this file declared, in creation order. */
  symbolNames:string[];
  /** Weak dependencies that were absent when the file was linked. */
  missingWeak:string[];
  rank:number;
}

interface Generation{
  id:number;
  files:Map<string,LinkedFile>;
  table:SymbolTable;
}

interface PendingEntry{
  node:FileNode;
  hash:string;
  symbolNames:string[];
  pendingOn:Set<string>;
  /** Set when a link attempt failed. Permanent for the current file set:
   *  everything visible to the file is linked and immutable, so the same
   *  attempt would fail again. Cleared only by `replaceFile`, a revision
   *  that rebuilds the file, or a generation swap that removes the cause
   *  of failure. */
  failed:boolean;
  lastError:DescriptorError|null;
}

export interface CommitResult{
  /** Monotonic id of the generation now served (unchanged by a no-op
   *  commit of identical contents). */
  readonly generation:number;
  /** Files rebuilt by this commit: the batch plus every transitive
   *  dependent that had to be rebuilt against it, sorted by name. */
  readonly updatedFiles:readonly string[];
}

/** Declares against two layers: the live generation's table and a
 *  pending-only overlay. Package components may be shared across layers.
 *  Duplicate detection sees both. */
class LayeredDeclarer implements SymbolDeclarer{
  constructor(
    private readonly base:SymbolTable,
    private readonly overlay:SymbolTable,
  ){}

  add(fullName:string,kind:SymbolKind,file:string):{created:boolean}{
    if(kind==='package'){
      if(this.base.get(fullName)?.kind==='package'||this.overlay.get(fullName)?.kind==='package')
        return{created:false};
    }
    if(this.base.has(fullName))return this.base.add(fullName,kind,file);
    return this.overlay.add(fullName,kind,file);
  }
}

export class DescriptorPool{
  private generation:Generation=DescriptorPool.emptyGeneration(0);
  private readonly pending=new Map<string,PendingEntry>();
  /** Declarations owned by still-pending files. */
  private readonly overlay=new SymbolTable();
  /** Bumped on every pending-registry change, so a revision prepared
   *  before an addFile/replaceFile cannot be committed afterwards. */
  private pendingVersion=0;

  private static emptyGeneration(id:number):Generation{
    return{id,files:new Map(),table:new SymbolTable()};
  }

  // ------------------------------------------------------------------
  // Mutation: incremental registration
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
   * `prepareRevision`/`commitRevision` for published ones.
   */
  addFile(node:FileNode):FileDescriptor|null{
    const linked=this.generation.files.get(node.name);
    if(linked){
      if(linked.hash===hashNode(node))return linked.descriptor;
      throw new DuplicateFileError(node.name);
    }
    const waiting=this.pending.get(node.name);
    if(waiting){
      if(waiting.hash===hashNode(node))return null;
      throw new DuplicateFileError(node.name);
    }
    this.registerPending(node);
    const errors=this.advance();
    if(errors.length>0)throw errors[0];
    return this.generation.files.get(node.name)?.descriptor??null;
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
    if(this.generation.files.has(node.name))throw new FrozenDescriptorError();
    if(this.pending.has(node.name))this.withdrawPending(node.name);
    this.registerPending(node);
    const errors=this.advance();
    if(errors.length>0)throw errors[0];
    return this.generation.files.get(node.name)?.descriptor??null;
  }

  private registerPending(node:FileNode):void{
    validateImportIndices(node);

    const cycle=this.cycleThrough(node);
    if(cycle)throw new DependencyCycleError(cycle);

    const created:string[]=[];
    try{
      declareSymbols(new LayeredDeclarer(this.generation.table,this.overlay),node,created);
    }catch(e){
      // Only overlay-owned names can belong to this registration; a
      // package shared with the generation was never created by it.
      for(const name of created.reverse())
        if(this.overlay.has(name))this.overlay.delete(name);
      throw e;
    }

    const entry:PendingEntry={
      node,hash:hashNode(node),symbolNames:created,pendingOn:new Set(),
      failed:false,lastError:null,
    };
    this.pending.set(node.name,entry);
    this.pendingVersion++;
    this.refreshPendingOn(entry);
  }

  private withdrawPending(name:string):void{
    const entry=this.pending.get(name);
    if(!entry)return;
    for(const symbolName of entry.symbolNames.reverse())this.overlay.delete(symbolName);
    this.pending.delete(name);
    this.pendingVersion++;
  }

  private refreshPendingOn(entry:PendingEntry):void{
    entry.pendingOn.clear();
    entry.node.dependencies.forEach((depName,i)=>{
      if(entry.node.weakDependencies.includes(i))return;
      if(!this.generation.files.has(depName))entry.pendingOn.add(depName);
    });
  }

  private refreshAllPendingOn():void{
    for(const entry of this.pending.values())this.refreshPendingOn(entry);
  }

  private pendingViewNodes():Map<string,FileNode>{
    const nodes=new Map<string,FileNode>();
    for(const linked of this.generation.files.values())nodes.set(linked.node.name,linked.node);
    for(const entry of this.pending.values())nodes.set(entry.node.name,entry.node);
    return nodes;
  }

  /**
   * Link every pending file whose dependencies are satisfied by the
   * current generation or by files linked earlier in the same run, in
   * dependency (then name) order, cascading to unblocked dependents.
   * Returns the errors of files that failed to link, in processing order.
   * On any progress a successor generation is installed atomically.
   */
  private advance():DescriptorError[]{
    const errors:DescriptorError[]=[];
    for(;;){
      const ranks=new Map<string,number>();
      for(const linked of this.generation.files.values())ranks.set(linked.node.name,linked.rank);
      const nodes=this.pendingViewNodes();
      const ready=[...this.pending.values()]
        .filter(e=>e.pendingOn.size===0&&!e.failed)
        .sort((a,b)=>rankOf(nodes,ranks,a.node.name)-rankOf(nodes,ranks,b.node.name)
          ||a.node.name.localeCompare(b.node.name));
      if(ready.length===0)return errors;

      const files=new Map(this.generation.files);
      // The candidate table starts from the live one; overlay symbols are
      // promoted as their files link. Old generation tables stay alive in
      // callers' old descriptor graphs.
      const table=this.generation.table.clone();
      const descriptors=new Map<string,FileDescriptor>();
      for(const linked of files.values())descriptors.set(linked.node.name,linked.descriptor);
      const linkedNow:string[]=[];

      for(const entry of ready){
        // Promote this entry's pending declarations. Every one is overlay-
        // owned (packages shared with the live table already exist there).
        for(const name of entry.symbolNames){
          if(table.has(name))continue;
          const symbol=this.overlay.get(name)!;
          table.add(name,symbol.kind,entry.node.name);
        }
        try{
          const ctx:LinkContext={nodes,table,descriptors};
          const result=linkFile(ctx,entry.node);
          descriptors.set(entry.node.name,result.descriptor);
          const linked:LinkedFile={
            node:entry.node,hash:entry.hash,descriptor:result.descriptor,
            symbolNames:entry.symbolNames.filter(n=>table.get(n)?.kind!=='package'),
            missingWeak:result.missingWeak,
            rank:rankOf(nodes,ranks,entry.node.name),
          };
          files.set(entry.node.name,linked);
          ranks.set(entry.node.name,linked.rank);
          linkedNow.push(entry.node.name);
        }catch(e){
          // Withdraw this file's promoted declarations from the candidate
          // table; they remain in the overlay as still-pending.
          for(const name of entry.symbolNames.reverse())
            if(table.get(name)?.file===entry.node.name)table.delete(name);
          entry.failed=true;
          entry.lastError=e as DescriptorError;
          errors.push(entry.lastError);
        }
      }

      if(linkedNow.length===0)return errors;

      for(const name of linkedNow)this.pending.delete(name);
      this.generation={id:this.generation.id+1,files,table};
      // Promoted symbols leave the overlay. Shared package components stay
      // while another pending file still uses them.
      for(const name of linkedNow)
        for(const symbolName of this.generation.files.get(name)!.symbolNames)
          if(!this.overlayDeclaresPackage(symbolName))this.overlay.delete(symbolName);
      this.refreshAllPendingOn();
    }
  }

  private overlayDeclaresPackage(name:string):boolean{
    return this.overlay.get(name)?.kind==='package';
  }

  /** Find an import cycle through `node` (which is not registered yet).
   *  Returns the cycle as a list of file names, or null. The graph of
   *  registered files is acyclic by invariant, so only cycles that close
   *  back on the new file can exist. */
  private cycleThrough(node:FileNode):string[]|null{
    const nodes=this.pendingViewNodes();
    const edgesOf=(name:string):string[]=>name===node.name?node.dependencies:nodes.get(name)?.dependencies??[];
    const stack:string[]=[node.name];
    const state=new Map<string,'visiting'|'done'>([[node.name,'visiting']]);
    const visit=(current:string):string[]|null=>{
      for(const dep of edgesOf(current)){
        if(dep===node.name)return[...stack,node.name];
        if(!nodes.has(dep)||state.has(dep))continue;
        state.set(dep,'visiting');
        stack.push(dep);
        const cycle=visit(dep);
        if(cycle)return cycle;
        stack.pop();
        state.set(dep,'done');
      }
      return null;
    };
    return visit(node.name);
  }

  // ------------------------------------------------------------------
  // Atomic revisions
  // ------------------------------------------------------------------

  /**
   * Validate a batch of file revisions as one complete candidate
   * generation and return a `PendingRevision` without changing anything
   * the pool currently serves.
   *
   * The batch may revise linked files and introduce new ones; its order is
   * irrelevant. Every transitive dependent (of any import kind) of a
   * revised file is rebuilt into the same candidate world, so unchanged
   * files cannot end up resolving against a mixed old/new symbol table.
   * Files outside that closure are carried over unchanged, keeping their
   * existing frozen descriptor objects.
   *
   * Per-file validation covers malformed import indices, duplicate files
   * inside the batch, revisions of still-pending files (use
   * `replaceFile`), missing non-weak dependencies (the set must be
   * complete — every import resolves either in the batch or in the
   * current generation), import cycles, duplicate symbols, unresolved or
   * invisible references, wrong symbol kinds and extension ranges.
   */
  prepareRevision(batch:readonly FileNode[]):PendingRevision{
    const failures:RevisionFailure[]=[];
    const fail=(file:string,e:unknown):void=>{
      failures.push({file,error:e as DescriptorError});
    };

    // --- Structural validation of the batch itself --------------------
    // Duplicate names inside the batch make the set ambiguous and abort
    // everything else; every other problem is collected and still allows
    // the independent declaration phase to report more errors.
    const byName=new Map<string,FileNode>();
    const seen=new Set<string>();
    let ambiguous=false;
    for(const node of[...batch].sort((a,b)=>a.name.localeCompare(b.name))){
      try{
        validateImportIndices(node);
      }catch(e){
        fail(node.name,e);
      }
      if(seen.has(node.name)){
        fail(node.name,new DuplicateFileError(node.name));
        ambiguous=true;
        continue;
      }
      seen.add(node.name);
      byName.set(node.name,node);
      if(this.pending.has(node.name))
        fail(node.name,new DescriptorError(
          `"${node.name}" is still pending; replace pending files with replaceFile before revising them`));
    }

    // --- Assemble the candidate node world ----------------------------
    const candidateNodes=new Map<string,FileNode>();
    for(const linked of this.generation.files.values())
      candidateNodes.set(linked.node.name,byName.get(linked.node.name)??linked.node);
    for(const node of byName.values())
      if(!candidateNodes.has(node.name))candidateNodes.set(node.name,node);

    // Every non-weak import of a revised file must exist in the set.
    for(const node of byName.values())
      node.dependencies.forEach((depName,i)=>{
        if(!node.weakDependencies.includes(i)&&!candidateNodes.has(depName))
          fail(node.name,new MissingDependencyError(node.name,depName,false));
      });

    // --- Import cycles -------------------------------------------------
    const cycle=findCycle(candidateNodes);
    if(cycle)fail(cycle.slice(0,-1).find(n=>byName.has(n))??cycle[0],new DependencyCycleError(cycle));

    // --- Rebuild closure: batch roots plus every transitive dependent --
    // A batch file is a root unless its contents are identical to the
    // published revision (a resubmission of the same file rebuilds
    // nothing).
    const roots=new Set<string>();
    for(const[name,node]of byName){
      const linked=this.generation.files.get(name);
      if(!linked||linked.hash!==hashNode(node))roots.add(name);
    }
    const closure=new Set<string>(roots);
    for(const dependent of transitiveDependents(candidateNodes,roots))closure.add(dependent);

    let plan:RevisionPlan|null=null;
    // Declarations are independent of dependency/cycle/index errors; run
    // them unless the batch itself was ambiguous.
    if(!ambiguous){
      // Candidate table = live table + pending overlay; rebuilt files'
      // own symbols are withdrawn before being re-declared.
      const table=this.generation.table.clone();
      for(const symbol of this.overlay)
        if(!table.has(symbol.fullName))table.add(symbol.fullName,symbol.kind,symbol.file);

      for(const name of closure){
        const linked=this.generation.files.get(name);
        if(!linked)continue;
        for(const symbolName of linked.symbolNames){
          const symbol=table.get(symbolName);
          if(symbol&&symbol.file===name)table.delete(symbolName);
        }
      }

      // Re-declare the closure in deterministic file-name order. A
      // declaration failure in one file is recorded but does not stop the
      // others from being checked, so every duplicate-symbol problem in
      // the batch is reported at once.
      const declaredNames=new Map<string,string[]>();
      for(const name of[...closure].sort()){
        const created:string[]=[];
        try{
          declareSymbols(table,candidateNodes.get(name)!,created);
          declaredNames.set(name,created);
        }catch(e){
          fail(name,e);
        }
      }

      // Linking requires the whole candidate set to be structurally sound.
      if(failures.length===0){
        // --- Link the rebuilt closure against the candidate world -----
        const descriptors=new Map<string,FileDescriptor>();
        const ranks=new Map<string,number>();
        for(const linked of this.generation.files.values())
          if(!closure.has(linked.node.name)){
            descriptors.set(linked.node.name,linked.descriptor);
            ranks.set(linked.node.name,linked.rank);
          }

        const planned=new Map<string,PlannedFile>();
        const remaining=new Set(closure);
        for(;;){
          const ready=[...remaining]
            .filter(name=>{
              const node=candidateNodes.get(name)!;
              return node.dependencies.every((dep,i)=>
                node.weakDependencies.includes(i)||!remaining.has(dep));
            })
            .sort((a,b)=>rankOf(candidateNodes,ranks,a)-rankOf(candidateNodes,ranks,b)||a.localeCompare(b));
          if(ready.length===0)break;
          for(const name of ready){
            remaining.delete(name);
            const node=candidateNodes.get(name)!;
            try{
              const ctx:LinkContext={nodes:candidateNodes,table,descriptors};
              const result=linkFile(ctx,node);
              descriptors.set(name,result.descriptor);
              const rank=rankOf(candidateNodes,ranks,name);
              ranks.set(name,rank);
              planned.set(name,{
                node,descriptor:result.descriptor,rebuilt:true,rank,
                symbolNames:declaredNames.get(name)!,missingWeak:result.missingWeak,
              });
            }catch(e){
              fail(name,e);
            }
          }
        }

        if(failures.length===0){
          // Pending declarations were seeded only so the rebuilt files
          // could collide with them; the new generation must not absorb
          // symbols of files it does not publish (a later replaceFile of
          // the pending file would otherwise leave dangling symbols).
          for(const seed of this.overlay){
            if(seed.kind==='package')continue;
            const candidate=table.get(seed.fullName);
            if(candidate&&candidate.file===seed.file&&candidate.kind===seed.kind)
              table.delete(seed.fullName);
          }

          // Carry unchanged files over, descriptor objects and all.
          for(const linked of this.generation.files.values())
            if(!closure.has(linked.node.name))
              planned.set(linked.node.name,{
                node:linked.node,descriptor:linked.descriptor,rebuilt:false,
                rank:linked.rank,symbolNames:linked.symbolNames,
                missingWeak:linked.missingWeak,
              });
          plan={
            baseGeneration:this.generation.id,
            basePendingVersion:this.pendingVersion,
            entries:planned,
            symbols:table,
            updated:[...closure].sort(),
          };
        }
      }
    }

    return new PendingRevision(failures,plan,[...byName.keys()].sort(),
      plan?plan.updated:[...closure].sort());
  }

  /**
   * Publish a prepared revision atomically. Throws RevisionValidationError
   * if the revision failed preparation (the pool is untouched), or
   * RevisionStaleError if the pool advanced after `prepareRevision` and
   * the revision must be prepared again.
   *
   * After the swap, pending files are re-linked against the new generation
   * in the same operation; their failures never roll back the committed
   * revision. A commit of identical contents does not advance the
   * generation.
   */
  commitRevision(revision:PendingRevision):CommitResult{
    if(!revision.ok||!revision.plan)
      throw new RevisionValidationError(revision.failures);
    const plan=revision.plan;
    if(plan.baseGeneration!==this.generation.id||plan.basePendingVersion!==this.pendingVersion)
      throw new RevisionStaleError();
    if(plan.updated.length===0)
      return{generation:this.generation.id,updatedFiles:[]};

    const files=new Map<string,LinkedFile>();
    for(const[name,entry]of plan.entries){
      const previous=this.generation.files.get(name);
      files.set(name,{
        node:entry.node,
        hash:hashNode(entry.node),
        descriptor:entry.descriptor,
        symbolNames:entry.rebuilt
          ?entry.symbolNames.filter(n=>plan.symbols.get(n)?.file===name&&plan.symbols.get(n)?.kind!=='package')
          :previous!.symbolNames,
        missingWeak:entry.rebuilt?entry.missingWeak:previous!.missingWeak,
        rank:entry.rank,
      });
    }

    this.generation={id:this.generation.id+1,files,table:plan.symbols};
    this.pendingVersion++;

    // The new generation can invalidate prior link failures of pending
    // files; let them retry against it.
    for(const entry of this.pending.values()){
      entry.failed=false;
      entry.lastError=null;
    }
    this.refreshAllPendingOn();
    this.advance();
    return{generation:this.generation.id,updatedFiles:[...plan.updated]};
  }

  /**
   * Convenience: prepare `batch` and, if it is a complete valid
   * generation, commit it in one call. Otherwise throws
   * RevisionValidationError listing every failing file and leaves the
   * pool unchanged.
   */
  commitRevisionOf(batch:readonly FileNode[]):CommitResult{
    const revision=this.prepareRevision(batch);
    if(!revision.ok)throw new RevisionValidationError(revision.failures);
    return this.commitRevision(revision);
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** The published descriptor for a linked file, else null. */
  getFileDescriptor(name:string):FileDescriptor|null{
    return this.generation.files.get(name)?.descriptor??null;
  }

  isLinked(name:string):boolean{return this.generation.files.has(name)}
  isPending(name:string):boolean{return this.pending.has(name)}
  isRegistered(name:string):boolean{
    return this.generation.files.has(name)||this.pending.has(name);
  }

  /** Monotonic id of the generation currently being served. Advances on
   *  every successful link cascade and every committed revision. */
  get generationId():number{return this.generation.id}

  /** Names of non-weak dependencies this file is still waiting for. */
  missingDependenciesOf(name:string):string[]{
    const entry=this.pending.get(name);
    return entry?[...entry.pendingOn].sort():[];
  }

  /** Weak dependencies that were absent when the file was linked. */
  missingWeakDependenciesOf(name:string):string[]{
    return this.generation.files.get(name)?.missingWeak.slice()??[];
  }

  /** The error from the last failed link attempt of a pending file. */
  fileError(name:string):DescriptorError|null{
    return this.pending.get(name)?.lastError??null;
  }

  pendingFiles():string[]{
    return[...this.pending.keys()].sort();
  }

  linkedFiles():string[]{
    return[...this.generation.files.keys()].sort();
  }

  /** Look up any symbol by fully-qualified name (leading dot optional).
   *  Pending declarations are visible too, with null targets until they
   *  link. */
  findSymbol(fullName:string):Symbol|null{
    const name=stripDot(fullName);
    return this.generation.table.get(name)??this.overlay.get(name)??null;
  }

  findMessageTypeByName(fullName:string):MessageDescriptor|null{
    return this.findTypedSymbol(fullName,'message')as MessageDescriptor|null;
  }

  findEnumByName(fullName:string):EnumDescriptor|null{
    return this.findTypedSymbol(fullName,'enum')as EnumDescriptor|null;
  }

  findEnumValueByName(fullName:string):EnumValueDescriptor|null{
    return this.findTypedSymbol(fullName,'enum-value')as EnumValueDescriptor|null;
  }

  findServiceByName(fullName:string):ServiceDescriptor|null{
    return this.findTypedSymbol(fullName,'service')as ServiceDescriptor|null;
  }

  findFieldByName(fullName:string):FieldDescriptor|null{
    return this.findTypedSymbol(fullName,'field')as FieldDescriptor|null;
  }

  findExtensionByName(fullName:string):FieldDescriptor|null{
    return this.findTypedSymbol(fullName,'extension')as FieldDescriptor|null;
  }

  private findTypedSymbol(fullName:string,kind:SymbolKind):unknown{
    const symbol=this.findSymbol(fullName);
    return symbol&&symbol.kind===kind?symbol.target:null;
  }
}

function stripDot(name:string):string{
  return name.startsWith('.')?name.slice(1):name;
}

/** Deterministic structural hash of a FileNode (key order independent). */
export function hashNode(node:FileNode):string{
  return JSON.stringify(node,(key,value:unknown)=>
    value&&typeof value==='object'&&!Array.isArray(value)
      ?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)))
      :value);
}
