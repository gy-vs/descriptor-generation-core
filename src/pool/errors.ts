/** Error hierarchy for the descriptor pool. */

export class DescriptorError extends Error{
  constructor(message:string){super(message);this.name=new.target.name}
}

/** A dependency of a file is not (yet) registered in the pool. */
export class MissingDependencyError extends DescriptorError{
  constructor(
    /** The file whose dependency is missing. */
    readonly file:string,
    /** The missing dependency name. */
    readonly dependency:string,
    /** True when the import was declared `weak`. */
    readonly weak:boolean,
  ){super(`"${file}" imports "${dependency}", which has not been loaded${weak?' (weak import)':''}`)}
}

/** The same file name was registered with different contents. */
export class DuplicateFileError extends DescriptorError{
  constructor(readonly file:string){
    super(`"${file}" is already registered with different contents`);
  }
}

/** A symbol name was declared twice in the same scope. */
export class DuplicateSymbolError extends DescriptorError{
  constructor(
    readonly symbol:string,
    readonly file:string,
    readonly otherFile:string,
  ){super(`"${symbol}" is already defined${file===otherFile?'':` in "${otherFile}"`} (redefined in "${file}")`)}
}

/** The import graph contains a cycle. */
export class DependencyCycleError extends DescriptorError{
  constructor(readonly cycle:string[]){
    super(`cycle in import graph: ${cycle.join(' -> ')}`);
  }
}

/** A type name could not be resolved. */
export class SymbolLookupError extends DescriptorError{
  constructor(
    /** The name as written in the source. */
    readonly name:string,
    /** Every fully-qualified candidate that was tried, in order. */
    readonly searchPath:string[],
  ){
    super(`"${name}" is not resolved; searched: ${searchPath.map(c=>`"${c}"`).join(', ')||'(no candidates)'}`);
  }
}

/** A name resolved to the wrong kind of symbol (e.g. a field used as a type). */
export class SymbolKindError extends DescriptorError{
  constructor(readonly name:string,readonly expected:string,readonly actual:string){
    super(`"${name}" is a ${actual}, not a ${expected}`);
  }
}

/** A symbol was resolved but its defining file is not (transitively, via
 *  direct or public imports) visible from the referencing file. */
export class NotImportedError extends DescriptorError{
  constructor(
    readonly symbol:string,
    readonly definingFile:string,
    readonly referencingFile:string,
  ){
    super(`"${symbol}" is defined in "${definingFile}", which is not imported by "${referencingFile}"; add the import or use a public import`);
  }
}

/** An extension targets a message that does not allow extensions in that range. */
export class ExtensionRangeError extends DescriptorError{
  constructor(readonly extendee:string,readonly fieldNumber:number){
    super(`"${extendee}" does not declare ${fieldNumber} as an extension range`);
  }
}

/** An operation was attempted on a published (immutable) descriptor. */
export class FrozenDescriptorError extends DescriptorError{
  constructor(){super('descriptor has been published and is immutable')}
}

/** One file of a proposed revision prevents the new generation from
 *  publishing. `cause` is the concrete declaration/link error that was
 *  produced while building the candidate generation; `revisionFile` is the
 *  submitted file that is responsible for it (the failed file itself when
 *  it is part of the revision, otherwise the closest submitted ancestor in
 *  the import graph). */
export class RevisionFileError extends DescriptorError{
  constructor(
    /** The submitted file responsible for the failure. */
    readonly revisionFile:string,
    /** The file on which the concrete error was detected (may differ
     *  from `revisionFile` for an unrevised dependent that stopped
     *  resolving against the revised definitions). */
    readonly failedFile:string,
    readonly cause:DescriptorError,
  ){
    super(`revision file "${revisionFile}" prevents publication`
      +(failedFile===revisionFile?'':` (failure detected in "${failedFile}")`)
      +`: ${cause.message}`);
  }
}

/** A revision could not be prepared: none of its files have been
 *  published and the previous generation remains fully in service. */
export class RevisionRejectedError extends DescriptorError{
  constructor(readonly errors:RevisionFileError[]){
    super(
      errors.length===0
        ?'revision rejected'
        :`revision rejected (${errors.length} file${errors.length===1?'':'s'}): `
          +errors.map(e=>`"${e.revisionFile}": ${e.cause.message}`).join('; '),
    );
  }
}

/** A prepared revision is being committed against a generation that is no
 *  longer live: the pool accepted other registrations after the revision
 *  was prepared. Nothing was published by the failed commit. */
export class RevisionStaleError extends DescriptorError{
  constructor(){
    super('the generation this revision was prepared against is no longer current; prepare a new revision');
  }
}
