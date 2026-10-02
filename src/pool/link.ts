import type{EnumNode,ExtendNode,FileNode,MessageNode}from'./ast.js';
import{
  EnumDescriptor,
  FieldDescriptor,
  FileDescriptor,
  MessageDescriptor,
  MethodDescriptor,
  buildEnum,
  buildService,
  isScalarType,
}from'./descriptor.js';
import{
  DescriptorError,
  ExtensionRangeError,
  NotImportedError,
  SymbolKindError,
  SymbolLookupError,
}from'./errors.js';
import{SymbolTable}from'./symbols.js';
import type{Symbol,SymbolKind}from'./symbols.js';

/**
 * Pure linking machinery, shared by incremental registration and by
 * revision preparation. A link run works against a *view*: a map of
 * FileNodes that describes one candidate world, a symbol table for that
 * world, and a lookup of already-published descriptors (keyed by file
 * name). Nothing here mutates descriptor graphs that were published by a
 * previous run; every linked file produces fresh descriptors.
 */

/** Everything the linker needs to know about one candidate world. */
export interface LinkContext{
  /** All files participating in this world (published + pending or the
   *  full candidate set), keyed by file name. */
  nodes:ReadonlyMap<string,FileNode>;
  /** Symbol table of this world. */
  table:SymbolTable;
  /** Descriptors already linked inside this run or inherited from the
   *  generation this run builds upon. */
  descriptors:ReadonlyMap<string,FileDescriptor>;
}

/** A sink for the declaration pass: a SymbolTable or a layered view over
 *  several tables. */
export interface SymbolDeclarer{
  add(fullName:string,kind:SymbolKind,file:string):{created:boolean};
}

export interface FieldRef{field:FieldDescriptor;typeName:string;scope:string}
export interface ExtendRef{node:ExtendNode;fields:FieldDescriptor[];scope:string;scopeMsg:MessageDescriptor|null}
export interface MethodRef{method:MethodDescriptor;inputType:string;outputType:string;scope:string}

// ----------------------------------------------------------------------
// Phase 1: declaration
// ----------------------------------------------------------------------

/**
 * Declare every symbol introduced by `node` in `table`. Created symbol
 * names (in creation order) are pushed to `created`, so a failed
 * declaration can be rolled back. Package components already declared by
 * another file are shared and not included.
 */
export function declareSymbols(table:SymbolDeclarer,node:FileNode,created:string[]):void{
  const add=(fullName:string,kind:SymbolKind):void=>{
    if(table.add(fullName,kind,node.name).created)created.push(fullName);
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

// ----------------------------------------------------------------------
// Phase 2: linking
// ----------------------------------------------------------------------

/** Result of linking one file: the published descriptor plus the weak
 *  imports that were absent at link time. */
export interface LinkResult{
  descriptor:FileDescriptor;
  missingWeak:string[];
}

/**
 * Build and freeze the FileDescriptor for `node` inside `ctx`, resolving
 * every type reference against the context's symbol table. Throws the
 * first DescriptorError encountered.
 */
export function linkFile(ctx:LinkContext,node:FileNode):LinkResult{
  const{table}=ctx;
  const file=new FileDescriptor(node.name,node.package);

  const fieldRefs:FieldRef[]=[];
  const extendRefs:ExtendRef[]=[];
  const methodRefs:MethodRef[]=[];

  const qualify=(scope:string,name:string):string=>scope?`${scope}.${name}`:name;
  const setTarget=(fullName:string,target:unknown):void=>{
    const symbol=table.get(fullName);
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

  const visible=visibleFiles(ctx.nodes,node.name);

  // Pass B: resolve every collected reference.
  for(const ref of fieldRefs){
    const symbol=resolveType(table,ctx.nodes,visible,node.name,ref.typeName,ref.scope,'type');
    if(symbol.kind==='message')ref.field.messageType=symbol.target as MessageDescriptor;
    else ref.field.enumType=symbol.target as EnumDescriptor;
  }
  for(const ref of extendRefs){
    const symbol=resolveType(table,ctx.nodes,visible,node.name,ref.node.extendee,ref.scope,'message');
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
    ref.method.inputType=resolveType(table,ctx.nodes,visible,node.name,ref.inputType,ref.scope,'message').target as MessageDescriptor;
    ref.method.outputType=resolveType(table,ctx.nodes,visible,node.name,ref.outputType,ref.scope,'message').target as MessageDescriptor;
  }

  // Wire up dependencies in declaration order. Missing weak imports are
  // tolerated and recorded; anything else missing would have kept the
  // file pending (or failed revision validation).
  const missingWeak:string[]=[];
  node.dependencies.forEach((depName,i)=>{
    const dep=ctx.descriptors.get(depName);
    if(!dep){
      missingWeak.push(depName);
      return;
    }
    const visibility=node.weakDependencies.includes(i)?'weak'
      :node.publicDependencies.includes(i)?'public'
      :'direct';
    file.addDependency(dep,visibility);
  });

  file.freeze();
  return{descriptor:file,missingWeak};
}

/**
 * Resolve a type reference appearing in `scope` inside file `fileName`,
 * checking visibility against direct and public imports.
 * `expected` is 'message' for extendees and RPC types, 'type' for field
 * types (message or enum).
 */
function resolveType(
  table:SymbolTable,
  nodes:ReadonlyMap<string,FileNode>,
  visible:Set<string>,
  fileName:string,
  name:string,
  scope:string,
  expected:'message'|'type',
):Symbol{
  const searchPath:string[]=[];
  const symbol=table.resolve(name,scope,searchPath);
  if(!symbol)throw new SymbolLookupError(name,searchPath);
  if(!visible.has(symbol.file))
    throw new NotImportedError(name,symbol.file,fileName);
  if(expected==='message'&&symbol.kind!=='message')
    throw new SymbolKindError(name,'message',symbol.kind);
  if(expected==='type'&&symbol.kind!=='message'&&symbol.kind!=='enum')
    throw new SymbolKindError(name,'message or enum',symbol.kind);
  return symbol;
}

/** Files whose symbols `fileName` may use: itself, its direct imports
 *  (any visibility), and everything re-exported transitively through
 *  public imports. Missing files are simply absent from the set. */
export function visibleFiles(nodes:ReadonlyMap<string,FileNode>,fileName:string):Set<string>{
  const visible=new Set<string>([fileName]);
  const queue:string[]=[];
  for(const depName of nodes.get(fileName)?.dependencies??[])
    if(nodes.has(depName)&&!visible.has(depName)){
      visible.add(depName);
      queue.push(depName);
    }
  while(queue.length>0){
    const current=nodes.get(queue.shift()!)!;
    for(const pubName of current.publicDependencies.map(i=>current.dependencies[i]))
      if(nodes.has(pubName)&&!visible.has(pubName)){
        visible.add(pubName);
        queue.push(pubName);
      }
  }
  return visible;
}

// ----------------------------------------------------------------------
// Dependency graph
// ----------------------------------------------------------------------

/** All file names that (transitively) import any file in `roots`,
 *  following every import edge regardless of visibility. */
export function transitiveDependents(
  nodes:ReadonlyMap<string,FileNode>,
  roots:ReadonlySet<string>,
):Set<string>{
  const importers=new Map<string,string[]>();
  for(const node of nodes.values())
    for(const dep of node.dependencies){
      let set=importers.get(dep);
      if(!set)importers.set(dep,set=[]);
      set.push(node.name);
    }
  const result=new Set<string>();
  const queue=[...roots];
  while(queue.length>0){
    for(const name of importers.get(queue.shift()!)??[]){
      if(!result.has(name)){
        result.add(name);
        queue.push(name);
      }
    }
  }
  return result;
}

/** Find a cycle in the given graph. Returns the cycle as a list of file
 *  names (first and last equal), or null when the graph is acyclic.
 *  Iteration follows the dependency order of each node, and the search
 *  starts from the lexicographically first node, so the result is
 *  independent of how files were inserted. */
export function findCycle(nodes:ReadonlyMap<string,FileNode>):string[]|null{
  const state=new Map<string,'visiting'|'done'>();
  const stack:string[]=[];
  const visit=(current:string):string[]|null=>{
    state.set(current,'visiting');
    stack.push(current);
    for(const dep of nodes.get(current)?.dependencies??[]){
      if(!nodes.has(dep))continue;
      if(state.get(dep)==='visiting'){
        const at=stack.indexOf(dep);
        return[...stack.slice(at),dep];
      }
      if(!state.has(dep)){
        const cycle=visit(dep);
        if(cycle)return cycle;
      }
    }
    stack.pop();
    state.set(current,'done');
    return null;
  };
  for(const name of[...nodes.keys()].sort()){
    if(!state.has(name)){
      const cycle=visit(name);
      if(cycle)return cycle;
    }
  }
  return null;
}

/** Dependency depth of a node, computed over already-ranked files. */
export function rankOf(nodes:ReadonlyMap<string,FileNode>,ranks:ReadonlyMap<string,number>,name:string):number{
  let rank=0;
  for(const depName of nodes.get(name)?.dependencies??[]){
    const depRank=ranks.get(depName);
    if(depRank!==undefined)rank=Math.max(rank,depRank+1);
  }
  return rank;
}

export function validateImportIndices(node:FileNode):void{
  for(const index of[...node.publicDependencies,...node.weakDependencies])
    if(!Number.isInteger(index)||index<0||index>=node.dependencies.length)
      throw new DescriptorError(
        `"${node.name}": import index ${index} is out of range (${node.dependencies.length} dependencies)`);
}
