import type{FileDescriptor,MessageDescriptor,ServiceDescriptor,EnumDescriptor,MethodDescriptor,FieldDescriptor,EnumValueDescriptor}from'./descriptor.js';
import type{FileNode}from'./ast.js';
import type{RevisionFailure}from'./errors.js';
import type{Symbol,SymbolTable}from'./symbols.js';

/**
 * A candidate new generation, produced by `DescriptorPool.prepareRevision`
 * and published atomically with `DescriptorPool.commitRevision`.
 *
 * A prepared revision is a private snapshot: until it is committed, every
 * live query keeps answering from the older generation. The descriptors
 * reachable through this handle already belong to the candidate world and
 * are frozen; committing only swaps which generation the pool serves, it
 * never mutates any descriptor object.
 */
export interface PreparedFile{
  readonly name:string;
  readonly descriptor:FileDescriptor;
  /** True when this file was rebuilt because it is part of the submitted
   *  batch or is a transitive dependent of one; false for files carried
   *  over unchanged (their descriptor objects are shared with the current
   *  generation). */
  readonly rebuilt:boolean;
}

/** Internal, fully linked candidate world. Not exposed directly. */
export interface RevisionPlan{
  /** Generation token of the live pool this plan was built on. */
  readonly baseGeneration:number;
  /** Pending-registry version this plan was built on. */
  readonly basePendingVersion:number;
  /** Files of the candidate world (unchanged files reused as-is). */
  readonly entries:ReadonlyMap<string,PlannedFile>;
  /** Candidate symbol table, rebound onto candidate descriptors. */
  readonly symbols:SymbolTable;
  /** Files actually rebuilt (batch + dependent closure), sorted. */
  readonly updated:string[];
}

export interface PlannedFile{
  readonly node:FileNode;
  readonly descriptor:FileDescriptor;
  readonly rebuilt:boolean;
  readonly rank:number;
  readonly symbolNames:string[];
  /** Weak imports absent at link time in the candidate world. */
  readonly missingWeak:string[];
}

export class PendingRevision{
  /** @internal */
  constructor(
    /** Every problem that prevents publication, in deterministic order.
     *  Empty for a committable revision. */
    readonly failures:readonly RevisionFailure[],
    /** @internal */
    readonly plan:RevisionPlan|null,
    /** Names of the files supplied by the caller (the batch). */
    readonly batchFiles:readonly string[],
    /** Files that would be rebuilt on commit (batch + dependent closure). */
    readonly updatedFiles:readonly string[],
  ){}

  /** True when the revision is internally complete and may be committed. */
  get ok():boolean{return this.failures.length===0}

  /** The file primarily responsible, when the revision is not committable. */
  get failingFile():string|null{return this.failures[0]?.file??null}

  /** Candidate descriptor for a file. Rebuilt files have fresh
   *  descriptors; unaffected files return the same object the live pool
   *  currently serves. Available on failed revisions only for files that
   *  were carried over unchanged — prefer this on `ok` revisions. */
  getFileDescriptor(name:string):FileDescriptor|null{
    return this.plan?.entries.get(name)?.descriptor??null;
  }

  /** Look up a candidate symbol by fully-qualified name (leading dot
   *  optional). Returns null on an uncommittable revision. */
  findSymbol(fullName:string):Symbol|null{
    if(!this.plan)return null;
    return this.plan.symbols.get(stripDot(fullName))??null;
  }

  findMessageTypeByName(fullName:string):MessageDescriptor|null{
    return typedTarget(this,fullName,'message')as MessageDescriptor|null;
  }

  findEnumByName(fullName:string):EnumDescriptor|null{
    return typedTarget(this,fullName,'enum')as EnumDescriptor|null;
  }

  findEnumValueByName(fullName:string):EnumValueDescriptor|null{
    return typedTarget(this,fullName,'enum-value')as EnumValueDescriptor|null;
  }

  findServiceByName(fullName:string):ServiceDescriptor|null{
    return typedTarget(this,fullName,'service')as ServiceDescriptor|null;
  }

  findMethodByName(fullName:string):MethodDescriptor|null{
    return typedTarget(this,fullName,'method')as MethodDescriptor|null;
  }

  findFieldByName(fullName:string):FieldDescriptor|null{
    return typedTarget(this,fullName,'field')as FieldDescriptor|null;
  }

  findExtensionByName(fullName:string):FieldDescriptor|null{
    return typedTarget(this,fullName,'extension')as FieldDescriptor|null;
  }

  /** All candidate files, sorted by name. */
  files():PreparedFile[]{
    if(!this.plan)return[];
    return[...this.plan.entries.values()]
      .map(e=>({name:e.node.name,descriptor:e.descriptor,rebuilt:e.rebuilt}))
      .sort((a,b)=>a.name.localeCompare(b.name));
  }
}

function typedTarget(revision:PendingRevision,fullName:string,kind:string):unknown{
  if(!revision.plan)return null;
  const symbol=revision.plan.symbols.get(stripDot(fullName));
  return symbol&&symbol.kind===kind?symbol.target:null;
}

function stripDot(name:string):string{
  return name.startsWith('.')?name.slice(1):name;
}
