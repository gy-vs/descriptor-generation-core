/**
 * AST of a parsed `.proto` file: plain mutable data, produced by a parser
 * (or built by hand) before anything is registered in a pool.
 */

export type Label='optional'|'required'|'repeated';

export interface FieldNode{
  kind:'field';
  name:string;
  number:number;
  label:Label;
  /** Type name as written in the source: relative (`Sub`), dotted-relative
   *  (`pkg.Msg`) or fully-qualified (`.pkg.Msg`). Null for inline groups. */
  typeName:string|null;
  /** Inline group body, when the field is a group. */
  group:MessageNode|null;
}

export interface ExtensionRange{start:number;end:number}

export interface ExtendNode{
  kind:'extend';
  /** The extended message type, as written (relative or fully-qualified). */
  extendee:string;
  fields:FieldNode[];
}

export type MessageItem=MessageNode|EnumNode|FieldNode|ExtendNode;

export interface MessageNode{
  kind:'message';
  name:string;
  fields:FieldNode[];
  messages:MessageNode[];
  enums:EnumNode[];
  extends:ExtendNode[];
  extensionRanges:ExtensionRange[];
}

export interface EnumValueNode{name:string;number:number}

export interface EnumNode{
  kind:'enum';
  name:string;
  values:EnumValueNode[];
}

export interface MethodNode{
  kind:'method';
  name:string;
  inputType:string;
  outputType:string;
  clientStreaming:boolean;
  serverStreaming:boolean;
}

export interface ServiceNode{
  kind:'service';
  name:string;
  methods:MethodNode[];
}

export interface FileNode{
  kind:'file';
  /** Canonical file name, e.g. `google/protobuf/descriptor.proto`. */
  name:string;
  package:string;
  /** Direct dependencies, in declaration order. */
  dependencies:string[];
  publicDependencies:number[];
  weakDependencies:number[];
  messages:MessageNode[];
  enums:EnumNode[];
  services:ServiceNode[];
  extends:ExtendNode[];
}

export function fileNode(name:string,init?:Partial<Omit<FileNode,'kind'|'name'>>):FileNode{
  return{kind:'file',name,package:'',dependencies:[],publicDependencies:[],weakDependencies:[],
    messages:[],enums:[],services:[],extends:[],...init};
}

export function messageNode(name:string,init?:Partial<Omit<MessageNode,'kind'|'name'>>):MessageNode{
  return{kind:'message',name,fields:[],messages:[],enums:[],extends:[],extensionRanges:[],...init};
}

export function enumNode(name:string,values:EnumValueNode[]):EnumNode{
  return{kind:'enum',name,values};
}

export function fieldNode(name:string,number:number,typeName:string|null,label:Label='optional'):FieldNode{
  return{kind:'field',name,number,label,typeName,group:null};
}

export function serviceNode(name:string,methods:MethodNode[]):ServiceNode{
  return{kind:'service',name,methods};
}

export function methodNode(name:string,inputType:string,outputType:string):MethodNode{
  return{kind:'method',name,inputType,outputType,clientStreaming:false,serverStreaming:false};
}

export function extendNode(extendee:string,fields:FieldNode[]):ExtendNode{
  return{kind:'extend',extendee,fields};
}
