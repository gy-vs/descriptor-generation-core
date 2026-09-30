export function decodeVarint(data:Uint8Array,offset=0){let value=0n,shift=0n;for(let i=offset;i<data.length&&i<offset+10;i++){const byte=data[i];value|=BigInt(byte&127)<<shift;if(!(byte&128))return{value,length:i-offset+1};shift+=7n}return null}
export type Field={number:number;wireType:number;raw:Uint8Array};
export class DynamicMessage{fields:Field[]=[];add(field:Field){this.fields.push(field)}unknown(){return this.fields.slice()}}
export*from'./pool/index.js';
