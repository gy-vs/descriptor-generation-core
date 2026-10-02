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

/** One file in a candidate revision that prevented the new generation
 *  from being published. `error` is the underlying validation or link
 *  error and `file` is the candidate (or rebuilt dependent) file that
 *  must be fixed. */
export interface RevisionFailure{
  readonly file:string;
  readonly error:DescriptorError;
}

/** A candidate revision failed validation as a complete new generation.
 *  The live pool is untouched; every offending file is listed. */
export class RevisionValidationError extends DescriptorError{
  constructor(readonly failures:readonly RevisionFailure[]){
    super(
      `revision cannot be published (${failures.length} failing file${failures.length===1?'':'s'}):\n`+
      failures.map(f=>`  - "${f.file}": ${f.error.message}`).join('\n'),
    );
  }
}

/** A prepared revision was built against an older generation (the pool
 *  advanced afterwards). It must be prepared again before committing. */
export class RevisionStaleError extends DescriptorError{
  constructor(){super('revision was prepared against an older generation; prepare it again')}
}
