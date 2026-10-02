import{FrozenDescriptorError}from'./errors.js';
import type{EnumValueNode,ExtensionRange,FieldNode,Label,MethodNode}from'./ast.js';

/**
 * Immutable descriptors, produced by the pool's link phase.
 *
 * A descriptor graph is built bottom-up (children first) and published by
 * `freeze()`. Once frozen, every mutator throws FrozenDescriptorError and
 * `Object.freeze` prevents structural changes. Descriptors handed out by
 * `DescriptorPool` are always frozen.
 */

export type SymbolType='message'|'enum'|'service'|'field'|'extension'|'enum-value'|'method';

/** Built-in scalar field types; they never resolve through the symbol table. */
export const SCALAR_TYPES:ReadonlySet<string>=new Set([
  'double','float','int64','uint64','int32','fixed64','fixed32','bool',
  'string','bytes','uint32','sfixed32','sfixed64','sint32','sint64',
]);

export function isScalarType(name:string):boolean{
  return SCALAR_TYPES.has(name);
}

export abstract class Descriptor{
  private frozen=false;

  get isFrozen():boolean{return this.frozen}

  protected assertMutable():void{
    if(this.frozen)throw new FrozenDescriptorError();
  }

  /** Recursively publish this descriptor and everything it contains. */
  freeze():this{
    if(this.frozen)return this;
    this.freezeChildren();
    this.frozen=true;
    Object.freeze(this);
    return this;
  }

  protected freezeChildren():void{}

  abstract readonly name:string;
  abstract readonly fullName:string;
  abstract readonly file:FileDescriptor;
}

export class FieldDescriptor extends Descriptor{
  /** The message this field belongs to (the extendee for extensions).
   *  Set by the link phase. */
  containingType:MessageDescriptor|null=null;
  /** For extensions: the message in whose body the `extend` block
   *  appeared, or null for file-level extensions. Set by the link phase. */
  extensionScope:MessageDescriptor|null=null;
  /** Set by the link phase. */
  messageType:MessageDescriptor|null=null;
  enumType:EnumDescriptor|null=null;
  /** The built-in scalar type, when `typeName` is a scalar keyword. */
  readonly scalarType:string|null;

  constructor(
    readonly name:string,
    readonly fullName:string,
    readonly number:number,
    readonly label:Label,
    /** The type name as written in the source, or null for groups. */
    readonly typeName:string|null,
    readonly file:FileDescriptor,
    readonly isExtension:boolean,
  ){
    super();
    this.scalarType=typeName!==null&&isScalarType(typeName)?typeName:null;
  }

  get isRepeated():boolean{return this.label==='repeated'}

  static fromNode(node:FieldNode,fullName:string,file:FileDescriptor,isExtension:boolean):FieldDescriptor{
    return new FieldDescriptor(node.name,fullName,node.number,node.label,node.typeName,file,isExtension);
  }

  protected freezeChildren():void{
    // messageType/enumType are shared references, not children: they are
    // frozen by their own files. Nothing to do.
  }
}

export class EnumValueDescriptor extends Descriptor{
  constructor(
    readonly name:string,
    readonly fullName:string,
    readonly number:number,
    readonly type:EnumDescriptor,
  ){super()}

  get file():FileDescriptor{return this.type.file}
}

export class EnumDescriptor extends Descriptor{
  private readonly valueList:EnumValueDescriptor[]=[];
  private readonly valueByName=new Map<string,EnumValueDescriptor>();
  readonly values:readonly EnumValueDescriptor[]=this.valueList;

  constructor(
    readonly name:string,
    readonly fullName:string,
    readonly file:FileDescriptor,
    readonly containingType:MessageDescriptor|null,
  ){super()}

  addValue(value:EnumValueDescriptor):void{
    this.assertMutable();
    this.valueList.push(value);
    this.valueByName.set(value.name,value);
  }

  findValueByName(name:string):EnumValueDescriptor|null{
    return this.valueByName.get(name)??null;
  }

  protected freezeChildren():void{
    for(const v of this.valueList)v.freeze();
    Object.freeze(this.valueList);
  }
}

export class MessageDescriptor extends Descriptor{
  private readonly fieldList:FieldDescriptor[]=[];
  private readonly fieldByName=new Map<string,FieldDescriptor>();
  private readonly fieldByNumber=new Map<number,FieldDescriptor>();
  private readonly nestedList:MessageDescriptor[]=[];
  private readonly nestedByName=new Map<string,MessageDescriptor>();
  private readonly enumList:EnumDescriptor[]=[];
  private readonly enumByName=new Map<string,EnumDescriptor>();
  private readonly extensionList:FieldDescriptor[]=[];
  private readonly extensionRangeList:ExtensionRange[]=[];

  readonly fields:readonly FieldDescriptor[]=this.fieldList;
  readonly nestedTypes:readonly MessageDescriptor[]=this.nestedList;
  readonly enums:readonly EnumDescriptor[]=this.enumList;
  /** Extensions declared inside this message's body. */
  readonly extensions:readonly FieldDescriptor[]=this.extensionList;
  readonly extensionRanges:readonly ExtensionRange[]=this.extensionRangeList;

  constructor(
    readonly name:string,
    readonly fullName:string,
    readonly file:FileDescriptor,
    readonly containingType:MessageDescriptor|null,
  ){super()}

  addField(field:FieldDescriptor):void{
    this.assertMutable();
    this.fieldList.push(field);
    this.fieldByName.set(field.name,field);
    this.fieldByNumber.set(field.number,field);
  }

  addNestedType(type:MessageDescriptor):void{
    this.assertMutable();
    this.nestedList.push(type);
    this.nestedByName.set(type.name,type);
  }

  addEnum(enumDesc:EnumDescriptor):void{
    this.assertMutable();
    this.enumList.push(enumDesc);
    this.enumByName.set(enumDesc.name,enumDesc);
  }

  addExtension(field:FieldDescriptor):void{
    this.assertMutable();
    this.extensionList.push(field);
  }

  addExtensionRange(range:ExtensionRange):void{
    this.assertMutable();
    this.extensionRangeList.push(range);
  }

  findFieldByName(name:string):FieldDescriptor|null{
    return this.fieldByName.get(name)??null;
  }

  findFieldByNumber(number:number):FieldDescriptor|null{
    return this.fieldByNumber.get(number)??null;
  }

  findNestedTypeByName(name:string):MessageDescriptor|null{
    return this.nestedByName.get(name)??null;
  }

  findEnumByName(name:string):EnumDescriptor|null{
    return this.enumByName.get(name)??null;
  }

  isExtensionNumber(number:number):boolean{
    return this.extensionRangeList.some(r=>number>=r.start&&number<r.end);
  }

  protected freezeChildren():void{
    for(const f of this.fieldList)f.freeze();
    for(const f of this.extensionList)f.freeze();
    for(const t of this.nestedList)t.freeze();
    for(const e of this.enumList)e.freeze();
    Object.freeze(this.fieldList);
    Object.freeze(this.nestedList);
    Object.freeze(this.enumList);
    Object.freeze(this.extensionList);
    Object.freeze(this.extensionRangeList);
  }
}

export class MethodDescriptor extends Descriptor{
  inputType:MessageDescriptor|null=null;
  outputType:MessageDescriptor|null=null;

  constructor(
    readonly name:string,
    readonly fullName:string,
    readonly service:ServiceDescriptor,
    readonly clientStreaming:boolean,
    readonly serverStreaming:boolean,
  ){super()}

  get file():FileDescriptor{return this.service.file}
}

export class ServiceDescriptor extends Descriptor{
  private readonly methodList:MethodDescriptor[]=[];
  private readonly methodByName=new Map<string,MethodDescriptor>();
  readonly methods:readonly MethodDescriptor[]=this.methodList;

  constructor(
    readonly name:string,
    readonly fullName:string,
    readonly file:FileDescriptor,
  ){super()}

  addMethod(method:MethodDescriptor):void{
    this.assertMutable();
    this.methodList.push(method);
    this.methodByName.set(method.name,method);
  }

  findMethodByName(name:string):MethodDescriptor|null{
    return this.methodByName.get(name)??null;
  }

  protected freezeChildren():void{
    for(const m of this.methodList)m.freeze();
    Object.freeze(this.methodList);
  }
}

export class FileDescriptor extends Descriptor{
  private readonly messageList:MessageDescriptor[]=[];
  private readonly messageByName=new Map<string,MessageDescriptor>();
  private readonly enumList:EnumDescriptor[]=[];
  private readonly enumByName=new Map<string,EnumDescriptor>();
  private readonly serviceList:ServiceDescriptor[]=[];
  private readonly serviceByName=new Map<string,ServiceDescriptor>();
  private readonly extensionList:FieldDescriptor[]=[];

  readonly messageTypes:readonly MessageDescriptor[]=this.messageList;
  readonly enums:readonly EnumDescriptor[]=this.enumList;
  readonly services:readonly ServiceDescriptor[]=this.serviceList;
  /** Top-level extensions declared in this file. */
  readonly extensions:readonly FieldDescriptor[]=this.extensionList;
  readonly dependencies:readonly FileDescriptor[]=[];
  readonly publicDependencies:readonly FileDescriptor[]=[];
  readonly weakDependencies:readonly FileDescriptor[]=[];

  constructor(
    readonly name:string,
    readonly packageName:string,
  ){super()}

  get file():FileDescriptor{return this}

  /** Files are not symbols; their "full name" is the file name. */
  get fullName():string{return this.name}

  addMessageType(type:MessageDescriptor):void{
    this.assertMutable();
    this.messageList.push(type);
    this.messageByName.set(type.name,type);
  }

  addEnum(enumDesc:EnumDescriptor):void{
    this.assertMutable();
    this.enumList.push(enumDesc);
    this.enumByName.set(enumDesc.name,enumDesc);
  }

  addService(service:ServiceDescriptor):void{
    this.assertMutable();
    this.serviceList.push(service);
    this.serviceByName.set(service.name,service);
  }

  addExtension(field:FieldDescriptor):void{
    this.assertMutable();
    this.extensionList.push(field);
  }

  addDependency(dep:FileDescriptor,visibility:'direct'|'public'|'weak'):void{
    this.assertMutable();
    (this.dependencies as FileDescriptor[]).push(dep);
    if(visibility==='public')(this.publicDependencies as FileDescriptor[]).push(dep);
    if(visibility==='weak')(this.weakDependencies as FileDescriptor[]).push(dep);
  }

  findMessageTypeByName(name:string):MessageDescriptor|null{
    return this.messageByName.get(name)??null;
  }

  findEnumByName(name:string):EnumDescriptor|null{
    return this.enumByName.get(name)??null;
  }

  findServiceByName(name:string):ServiceDescriptor|null{
    return this.serviceByName.get(name)??null;
  }

  protected freezeChildren():void{
    for(const m of this.messageList)m.freeze();
    for(const e of this.enumList)e.freeze();
    for(const s of this.serviceList)s.freeze();
    for(const f of this.extensionList)f.freeze();
    Object.freeze(this.messageList);
    Object.freeze(this.enumList);
    Object.freeze(this.serviceList);
    Object.freeze(this.extensionList);
    Object.freeze(this.dependencies as FileDescriptor[]);
    Object.freeze(this.publicDependencies as FileDescriptor[]);
    Object.freeze(this.weakDependencies as FileDescriptor[]);
  }
}

/** Builders used by the link phase to assemble descriptor graphs. */

export function buildEnum(node:{name:string;values:EnumValueNode[]},fullName:string,file:FileDescriptor,parent:MessageDescriptor|null):EnumDescriptor{
  const enumDesc=new EnumDescriptor(node.name,fullName,file,parent);
  // Enum values are siblings of the enum: their full name uses the enum's
  // *parent* scope, matching the symbol table.
  const dot=fullName.lastIndexOf('.');
  const scope=dot<0?'':fullName.slice(0,dot);
  for(const v of node.values)
    enumDesc.addValue(new EnumValueDescriptor(v.name,scope?`${scope}.${v.name}`:v.name,v.number,enumDesc));
  return enumDesc;
}

export function buildService(node:{name:string;methods:MethodNode[]},fullName:string,file:FileDescriptor):ServiceDescriptor{
  const service=new ServiceDescriptor(node.name,fullName,file);
  for(const m of node.methods)
    service.addMethod(new MethodDescriptor(m.name,`${fullName}.${m.name}`,service,m.clientStreaming,m.serverStreaming));
  return service;
}
