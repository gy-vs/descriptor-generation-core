import{DuplicateSymbolError}from'./errors.js';

/**
 * The pool-wide symbol table.
 *
 * Symbols are fully-qualified, dot-separated names with no leading dot
 * (`foo.bar.Msg`). Packages/scopes and declared symbols (message, enum,
 * enum value, service, method, field, extension) share a single namespace,
 * matching protobuf semantics: `a.b` may not be both a package and a type.
 */

export type SymbolKind=
  |'package'
  |'message'
  |'field'
  |'enum'
  |'enum-value'
  |'service'
  |'method'
  |'extension';

export interface Symbol{
  /** Fully-qualified name without a leading dot. */
  readonly fullName:string;
  readonly kind:SymbolKind;
  /** Name of the file that declared this symbol. */
  readonly file:string;
  /** The linked descriptor, once the declaring file has been linked. */
  target:unknown;
}

export class SymbolTable{
  private readonly symbols=new Map<string,Symbol>();

  /**
   * Register a symbol. `kind` may be `'package'` to declare a pure
   * namespace component. Returns the symbol and whether it was newly
   * created (a package component may already exist).
   *
   * Throws DuplicateSymbolError when a non-package symbol is redeclared or
   * when a package and a symbol collide on the same name.
   */
  add(fullName:string,kind:SymbolKind,file:string):{symbol:Symbol;created:boolean}{
    const existing=this.symbols.get(fullName);
    if(existing){
      if(kind==='package'&&existing.kind==='package')
        return{symbol:existing,created:false};
      throw new DuplicateSymbolError(fullName,file,existing.file);
    }
    const symbol:Symbol={fullName,kind,file,target:null};
    this.symbols.set(fullName,symbol);
    return{symbol,created:true};
  }

  get(fullName:string):Symbol|undefined{
    return this.symbols.get(fullName);
  }

  has(fullName:string):boolean{
    return this.symbols.has(fullName);
  }

  delete(fullName:string):void{
    this.symbols.delete(fullName);
  }

  /** Shallow copy: symbols are shared (including their resolved targets),
   *  but additions/deletions on the copy never affect the original. Used
   *  when a candidate generation is staged from a live one. */
  clone():SymbolTable{
    const copy=new SymbolTable();
    for(const[name,symbol]of this.symbols)copy.symbols.set(name,symbol);
    return copy;
  }

  /** All registered symbols (declaration order not guaranteed). */
  all():Symbol[]{
    return[...this.symbols.values()];
  }

  /**
   * Resolve a type name against a scope, following protobuf's C++-style
   * scoping rules.
   *
   * `name` is the type as written in the source. `scope` is the
   * fully-qualified scope in which the reference appears (the innermost
   * message scope, or the file's package for top-level references).
   *
   * Returns the matched symbol, or `null` when nothing matches. When
   * `searchPath` is provided, every fully-qualified candidate that was
   * tried is appended to it, in order, so callers can report the complete
   * lookup path.
   *
   * Rules:
   *  - A leading dot means fully-qualified: the name is looked up as-is.
   *  - Otherwise the *first component* of the name is searched in the
   *    innermost scope first, then outward, finishing at the root. Once
   *    the first component matches, the remaining components are resolved
   *    beneath it with no fallback to outer scopes: a closer scope that
   *    declares a colliding first component shadows every outer
   *    definition, even if the full name would only resolve further out.
   */
  resolve(name:string,scope:string,searchPath?:string[]):Symbol|null{
    if(name.startsWith('.')){
      const fqn=name.slice(1);
      searchPath?.push(fqn);
      return this.symbols.get(fqn)??null;
    }

    // Scopes from innermost to outermost, finishing at the root ('').
    const scopes:string[]=[];
    for(let s=scope;;){
      scopes.push(s);
      if(!s)break;
      const dot=s.lastIndexOf('.');
      s=dot<0?'':s.slice(0,dot);
    }

    const firstComponent=name.split('.',1)[0];
    for(const s of scopes){
      const firstCandidate=s?`${s}.${firstComponent}`:firstComponent;
      const first=this.symbols.get(firstCandidate);
      if(!first)continue;
      // The first component exists here: it shadows all outer scopes.
      searchPath?.push(firstCandidate);
      const rest=name.slice(firstComponent.length);
      if(!rest)return first;
      let current=first;
      let full=firstCandidate;
      for(const part of rest.slice(1).split('.')){
        full=`${full}.${part}`;
        searchPath?.push(full);
        const next=this.symbols.get(full);
        if(!next)return null;
        current=next;
      }
      return current;
    }
    // No scope declared the first component. Record the full candidate at
    // each scope for diagnostics.
    for(const s of scopes)
      searchPath?.push(s?`${s}.${name}`:name);
    return null;
  }
}
