import type{EnumNode,ExtendNode,FileNode,MessageNode}from'./ast.js';
import{
  EnumDescriptor,
  EnumValueDescriptor,
  FieldDescriptor,
  FileDescriptor,
  MessageDescriptor,
  MethodDescriptor,
  ServiceDescriptor,
  buildEnum,
  buildService,
  isScalarType,
}from'./descriptor.js';
import{
  DependencyCycleError,
  DescriptorError,
  DuplicateFileError,
  ExtensionRangeError,
  FrozenDescriptorError,
  NotImportedError,
  SymbolKindError,
  SymbolLookupError,
}from'./errors.js';
import{SymbolTable}from'./symbols.js';
import type{Symbol,SymbolKind}from'./symbols.js';

/**
 * A descriptor pool: registers `.proto` files (in any order), tracks their
 * dependencies, and links them into immutable descriptor graphs.
 *
 * The two phases are strictly separated:
 *
 *  1. Declaration (at `addFile` time): the file's package, message, enum,
 *     enum-value, service, method, field and extension symbols are
 *     registered in the pool-wide symbol table. Duplicate symbols and
 *     import cycles are reported here, even while dependencies are missing.
 *
 *  2. Linking (incremental, automatic): a file whose dependencies have all
 *     been linked is linked itself — every type reference is resolved
 *     against the symbol table, visibility is checked against direct and
 *     public imports, and an immutable FileDescriptor graph is published.
 *     Linking one file cascades to the files that were waiting on it.
 *
 * Files with missing dependencies stay pending. A missing `weak` import
 * never blocks linking. A pending file may be replaced by a new revision
 * with `replaceFile`; a linked (published) file is immutable and cannot be
 * replaced.
 */

type FileStatus='pending'|'linked';

interface FileEntry{
  node:FileNode;
  hash:string;
  status:FileStatus;
  descriptor:FileDescriptor|null;
  /** Symbols created by this file's declare phase, in creation order. */
  symbolNames:string[];
  /** Names of direct, non-weak dependencies that are not linked yet. */
  pendingOn:Set<string>;
  /** Weak dependencies that were absent when the file was linked. */
  missingWeak:string[];
  /** Set when the link attempt failed. Permanent for the current file
   *  set: everything visible to the file is linked and immutable, so the
   *  same attempt would fail again. Cleared only by `replaceFile`. */
  failed:boolean;
  lastError:DescriptorError|null;
  /** Dependency depth, valid once linked. Used for deterministic ordering. */
  rank:number;
}

interface FieldRef{field:FieldDescriptor;typeName:string;scope:string}
interface ExtendRef{node:ExtendNode;fields:FieldDescriptor[];scope:string;scopeMsg:MessageDescriptor|null}
interface MethodRef{method:MethodDescriptor;inputType:string;outputType:string;scope:string}

export class DescriptorPool{
  private readonly table=new SymbolTable();
  private readonly files=new Map<string,FileEntry>();
  /** dep file name -> names of files that import it (any visibility). */
  private readonly dependents=new Map<string,Set<string>>();

  // ------------------------------------------------------------------
  // Mutation
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
   * DuplicateFileError — use `replaceFile` for revisions.
   */
  addFile(node:FileNode):FileDescriptor|null{
    const existing=this.files.get(node.name);
    if(existing){
      if(existing.hash===hashNode(node))return existing.descriptor;
      throw new DuplicateFileError(node.name);
    }
    this.validateImportIndices(node);

    const cycle=this.cycleThrough(node);
    if(cycle)throw new DependencyCycleError(cycle);

    const created:string[]=[];
    try{
      this.declareSymbols(node,created);
    }catch(e){
      for(const name of created.reverse())this.table.delete(name);
      throw e;
    }

    const entry:FileEntry={
      node,hash:hashNode(node),status:'pending',descriptor:null,
      symbolNames:created,pendingOn:new Set(),missingWeak:[],
      failed:false,lastError:null,rank:0,
    };
    this.files.set(node.name,entry);

    node.dependencies.forEach((depName,i)=>{
      addToSetMap(this.dependents,depName,node.name);
      if(node.weakDependencies.includes(i))return;
      const dep=this.files.get(depName);
      if(!dep||dep.status!=='linked')entry.pendingOn.add(depName);
    });

    const errors=this.cascade();

    if(errors.length>0)throw errors[0];
    return entry.descriptor;
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
    const existing=this.files.get(node.name);
    if(!existing)return this.addFile(node);
    if(existing.status==='linked')throw new FrozenDescriptorError();
    for(const name of[...existing.symbolNames].reverse())this.table.delete(name);
    for(const depName of existing.node.dependencies)
      removeFromSetMap(this.dependents,depName,node.name);
    this.files.delete(node.name);
    return this.addFile(node);
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** The published descriptor for a linked file, else null. */
  getFileDescriptor(name:string):FileDescriptor|null{
    return this.files.get(name)?.descriptor??null;
  }

  isLinked(name:string):boolean{return this.files.get(name)?.status==='linked'}
  isPending(name:string):boolean{return this.files.get(name)?.status==='pending'}
  isRegistered(name:string):boolean{return this.files.has(name)}

  /** Names of non-weak dependencies this file is still waiting for. */
  missingDependenciesOf(name:string):string[]{
    const entry=this.files.get(name);
    return entry?[...entry.pendingOn].sort():[];
  }

  /** Weak dependencies that were absent when the file was linked. */
  missingWeakDependenciesOf(name:string):string[]{
    return this.files.get(name)?.missingWeak.slice()??[];
  }

  /** The error from the last failed link attempt of a file, if any. */
  fileError(name:string):DescriptorError|null{
    return this.files.get(name)?.lastError??null;
  }

  pendingFiles():string[]{
    return[...this.files.values()].filter(e=>e.status==='pending').map(e=>e.node.name).sort();
  }

  linkedFiles():string[]{
    return[...this.files.values()].filter(e=>e.status==='linked').map(e=>e.node.name).sort();
  }

  /** Look up any symbol by fully-qualified name (leading dot optional). */
  findSymbol(fullName:string):Symbol|null{
    return this.table.get(stripDot(fullName))??null;
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
    const symbol=this.table.get(stripDot(fullName));
    return symbol&&symbol.kind===kind?symbol.target:null;
  }

  // ------------------------------------------------------------------
  // Phase 1: declaration
  // ------------------------------------------------------------------

  private declareSymbols(node:FileNode,created:string[]):void{
    const add=(fullName:string,kind:SymbolKind):void=>{
      if(this.table.add(fullName,kind,node.name).created)created.push(fullName);
    };
    const qualify=(scope:string,name:string):string=>scope?`${scope}.${name}`:name;

    if(node.package){
      const parts=node.package.split('.');
      for(let i=1;i<=parts.length;i++)add(parts.slice(0,i).join('.'),'package');
    }

    const declareEnum=(e:EnumNode,scope:string):void=>{
      add(qualify(scope,e.name),'enum');
      // Enum values are siblings of the enum, not children.
      for(const v of e.values)add(qualify(scope,v.name),'enum-value');
    };

    const declareMessage=(m:MessageNode,scope:string):void=>{
      const fullName=qualify(scope,m.name);
      add(fullName,'message');
      for(const f of m.fields){
        add(qualify(fullName,f.name),'field');
        if(f.group)declareMessage(f.group,fullName);
      }
      for(const nested of m.messages)declareMessage(nested,fullName);
      for(const e of m.enums)declareEnum(e,fullName);
      for(const x of m.extends)for(const f of x.fields){
        add(qualify(fullName,f.name),'extension');
        if(f.group)declareMessage(f.group,fullName);
      }
    };

    for(const m of node.messages)declareMessage(m,node.package);
    for(const e of node.enums)declareEnum(e,node.package);
    for(const s of node.services){
      const fullName=qualify(node.package,s.name);
      add(fullName,'service');
      for(const me of s.methods)add(qualify(fullName,me.name),'method');
    }
    for(const x of node.extends)for(const f of x.fields){
      add(qualify(node.package,f.name),'extension');
      if(f.group)declareMessage(f.group,node.package);
    }
  }

  // ------------------------------------------------------------------
  // Phase 2: linking
  // ------------------------------------------------------------------

  /** Link every file whose dependencies are satisfied, in dependency
   *  (then name) order, cascading to unblocked dependents. Returns the
   *  errors of files that failed to link, in processing order. A link
   *  failure is permanent for the current file set: every file visible to
   *  the failed file is linked and immutable, so only `replaceFile` can
   *  change the outcome. */
  private cascade():DescriptorError[]{
    const errors:DescriptorError[]=[];
    for(;;){
      const ready=[...this.files.values()]
        .filter(e=>e.status==='pending'&&e.pendingOn.size===0&&!e.failed)
        .sort((a,b)=>this.rankOf(a)-this.rankOf(b)||a.node.name.localeCompare(b.node.name));
      if(ready.length===0)return errors;
      for(const entry of ready){
        try{
          this.link(entry);
        }catch(e){
          entry.failed=true;
          entry.lastError=e as DescriptorError;
          errors.push(entry.lastError);
        }
      }
    }
  }

  private link(entry:FileEntry):void{
    entry.lastError=null;
    const{node}=entry;
    const file=new FileDescriptor(node.name,node.package);

    const fieldRefs:FieldRef[]=[];
    const extendRefs:ExtendRef[]=[];
    const methodRefs:MethodRef[]=[];

    const qualify=(scope:string,name:string):string=>scope?`${scope}.${name}`:name;
    const setTarget=(fullName:string,target:unknown):void=>{
      const symbol=this.table.get(fullName);
      if(symbol)symbol.target=target;
    };

    // Pass A: build the descriptor tree and collect references.
    const buildEnumDecl=(e:EnumNode,scope:string,parent:MessageDescriptor|null):EnumDescriptor=>{
      const enumDesc=buildEnum(e,qualify(scope,e.name),file,parent);
      setTarget(enumDesc.fullName,enumDesc);
      for(const v of enumDesc.values)setTarget(v.fullName,v);
      return enumDesc;
    };

    const buildMessageDecl=(m:MessageNode,scope:string,parent:MessageDescriptor|null):MessageDescriptor=>{
      const fullName=qualify(scope,m.name);
      const msg=new MessageDescriptor(m.name,fullName,file,parent);
      setTarget(fullName,msg);
      for(const range of m.extensionRanges)msg.addExtensionRange(range);
      for(const f of m.fields){
        const field=FieldDescriptor.fromNode(f,qualify(fullName,f.name),file,false);
        field.containingType=msg;
        msg.addField(field);
        setTarget(field.fullName,field);
        if(f.group){
          const group=buildMessageDecl(f.group,fullName,msg);
          msg.addNestedType(group);
          field.messageType=group;
        }else if(f.typeName&&!isScalarType(f.typeName)){
          fieldRefs.push({field,typeName:f.typeName,scope:fullName});
        }
      }
      for(const nested of m.messages)msg.addNestedType(buildMessageDecl(nested,fullName,msg));
      for(const e of m.enums)msg.addEnum(buildEnumDecl(e,fullName,msg));
      for(const x of m.extends)
        extendRefs.push({node:x,fields:buildExtensionFields(x,fullName,msg),scope:fullName,scopeMsg:msg});
      return msg;
    };

    const buildExtensionFields=(x:ExtendNode,scope:string,scopeMsg:MessageDescriptor|null):FieldDescriptor[]=>{
      const fields:FieldDescriptor[]=[];
      for(const f of x.fields){
        const field=FieldDescriptor.fromNode(f,qualify(scope,f.name),file,true);
        setTarget(field.fullName,field);
        if(f.group){
          // A group inside an extend block declares its message type in
          // the enclosing scope.
          const group=buildMessageDecl(f.group,scope,scopeMsg);
          if(scopeMsg)scopeMsg.addNestedType(group);
          else file.addMessageType(group);
          field.messageType=group;
        }else if(f.typeName&&!isScalarType(f.typeName)){
          fieldRefs.push({field,typeName:f.typeName,scope});
        }
        fields.push(field);
      }
      return fields;
    };

    for(const m of node.messages)file.addMessageType(buildMessageDecl(m,node.package,null));
    for(const e of node.enums)file.addEnum(buildEnumDecl(e,node.package,null));
    for(const s of node.services){
      const service=buildService(s,qualify(node.package,s.name),file);
      setTarget(service.fullName,service);
      service.methods.forEach((method,i)=>{
        setTarget(method.fullName,method);
        methodRefs.push({method,inputType:s.methods[i].inputType,outputType:s.methods[i].outputType,scope:node.package});
      });
      file.addService(service);
    }
    for(const x of node.extends)
      extendRefs.push({node:x,fields:buildExtensionFields(x,node.package,null),scope:node.package,scopeMsg:null});

    // Pass B: resolve every collected reference.
    for(const ref of fieldRefs){
      const symbol=this.resolveType(ref.typeName,ref.scope,entry,'type');
      if(symbol.kind==='message')ref.field.messageType=symbol.target as MessageDescriptor;
      else ref.field.enumType=symbol.target as EnumDescriptor;
    }
    for(const ref of extendRefs){
      const symbol=this.resolveType(ref.node.extendee,ref.scope,entry,'message');
      const extendee=symbol.target as MessageDescriptor;
      for(const field of ref.fields){
        if(!extendee.isExtensionNumber(field.number))
          throw new ExtensionRangeError(extendee.fullName,field.number);
        field.containingType=extendee;
        field.extensionScope=ref.scopeMsg;
        if(ref.scopeMsg)ref.scopeMsg.addExtension(field);
        else file.addExtension(field);
      }
    }
    for(const ref of methodRefs){
      ref.method.inputType=this.resolveType(ref.inputType,ref.scope,entry,'message').target as MessageDescriptor;
      ref.method.outputType=this.resolveType(ref.outputType,ref.scope,entry,'message').target as MessageDescriptor;
    }

    // Wire up dependencies in declaration order. Missing weak imports are
    // tolerated and recorded; anything else missing would have kept the
    // file pending.
    entry.missingWeak=[];
    node.dependencies.forEach((depName,i)=>{
      const dep=this.files.get(depName);
      if(!dep||!dep.descriptor){
        entry.missingWeak.push(depName);
        return;
      }
      const visibility=node.weakDependencies.includes(i)?'weak'
        :node.publicDependencies.includes(i)?'public'
        :'direct';
      file.addDependency(dep.descriptor,visibility);
    });

    entry.rank=this.rankOf(entry);
    entry.descriptor=file;
    entry.status='linked';
    entry.failed=false;
    file.freeze();

    // Unblock dependents.
    for(const dependentName of this.dependents.get(node.name)??[])
      this.files.get(dependentName)?.pendingOn.delete(node.name);
  }

  /**
   * Resolve a type reference appearing in `scope` inside `entry`'s file,
   * checking visibility against direct and public imports.
   * `expected` is 'message' for extendees and RPC types, 'type' for field
   * types (message or enum).
   */
  private resolveType(name:string,scope:string,entry:FileEntry,expected:'message'|'type'):Symbol{
    const searchPath:string[]=[];
    const symbol=this.table.resolve(name,scope,searchPath);
    if(!symbol)throw new SymbolLookupError(name,searchPath);
    if(!this.visibleFiles(entry).has(symbol.file))
      throw new NotImportedError(name,symbol.file,entry.node.name);
    if(expected==='message'&&symbol.kind!=='message')
      throw new SymbolKindError(name,'message',symbol.kind);
    if(expected==='type'&&symbol.kind!=='message'&&symbol.kind!=='enum')
      throw new SymbolKindError(name,'message or enum',symbol.kind);
    return symbol;
  }

  /** Files whose symbols `entry`'s file may use: itself, its direct
   *  imports (any visibility), and everything re-exported transitively
   *  through public imports. */
  private visibleFiles(entry:FileEntry):Set<string>{
    const visible=new Set<string>([entry.node.name]);
    const queue:string[]=[];
    for(const depName of entry.node.dependencies)
      if(this.files.has(depName)&&!visible.has(depName)){
        visible.add(depName);
        queue.push(depName);
      }
    while(queue.length>0){
      const current=this.files.get(queue.shift()!)!;
      for(const pubName of publicDependencyNames(current.node))
        if(this.files.has(pubName)&&!visible.has(pubName)){
          visible.add(pubName);
          queue.push(pubName);
        }
    }
    return visible;
  }

  // ------------------------------------------------------------------
  // Dependency graph
  // ------------------------------------------------------------------

  /** Find an import cycle through `node` (which is not registered yet).
   *  Returns the cycle as a list of file names, or null. The graph of
   *  registered files is acyclic by invariant, so only cycles that close
   *  back on the new file can exist. */
  private cycleThrough(node:FileNode):string[]|null{
    const edgesOf=(name:string):string[]=>{
      if(name===node.name)return node.dependencies;
      return this.files.get(name)?.node.dependencies??[];
    };
    const stack:string[]=[node.name];
    const state=new Map<string,'visiting'|'done'>([[node.name,'visiting']]);
    const visit=(current:string):string[]|null=>{
      for(const dep of edgesOf(current)){
        if(dep===node.name)return[...stack,node.name];
        if(!this.files.has(dep)||state.has(dep))continue;
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

  /** Dependency depth: 0 for files without (linked) dependencies. */
  private rankOf(entry:FileEntry):number{
    let rank=0;
    for(const depName of entry.node.dependencies){
      const dep=this.files.get(depName);
      if(dep&&dep.status==='linked')rank=Math.max(rank,dep.rank+1);
    }
    return rank;
  }

  private validateImportIndices(node:FileNode):void{
    for(const index of[...node.publicDependencies,...node.weakDependencies])
      if(!Number.isInteger(index)||index<0||index>=node.dependencies.length)
        throw new DescriptorError(
          `"${node.name}": import index ${index} is out of range (${node.dependencies.length} dependencies)`);
  }
}

function publicDependencyNames(node:FileNode):string[]{
  return node.publicDependencies.map(i=>node.dependencies[i]);
}

function stripDot(name:string):string{
  return name.startsWith('.')?name.slice(1):name;
}

function addToSetMap(map:Map<string,Set<string>>,key:string,value:string):void{
  let set=map.get(key);
  if(!set)map.set(key,set=new Set());
  set.add(value);
}

function removeFromSetMap(map:Map<string,Set<string>>,key:string,value:string):void{
  const set=map.get(key);
  if(!set)return;
  set.delete(value);
  if(set.size===0)map.delete(key);
}

/** Deterministic structural hash of a FileNode (key order independent). */
export function hashNode(node:FileNode):string{
  return JSON.stringify(node,(key,value:unknown)=>
    value&&typeof value==='object'&&!Array.isArray(value)
      ?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)))
      :value);
}
