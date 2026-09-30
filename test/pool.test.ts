import{describe,expect,it}from'vitest';
import{
  DescriptorPool,
  DependencyCycleError,
  DuplicateFileError,
  DuplicateSymbolError,
  ExtensionRangeError,
  FrozenDescriptorError,
  NotImportedError,
  SymbolKindError,
  SymbolLookupError,
  enumNode,
  extendNode,
  fieldNode,
  fileNode,
  messageNode,
  methodNode,
  serviceNode,
}from'../src/index.js';
import type{FileNode}from'../src/index.js';

// ---------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------

/** common.proto: package acme.common; message Timestamp. */
function commonFile():FileNode{
  return fileNode('common.proto',{
    package:'acme.common',
    messages:[messageNode('Timestamp',{fields:[fieldNode('seconds',1,'int64')]})],
  });
}

/** base.proto: package acme.base; imports common.proto; message Base. */
function baseFile():FileNode{
  return fileNode('base.proto',{
    package:'acme.base',
    dependencies:['common.proto'],
    messages:[
      messageNode('Base',{
        fields:[
          fieldNode('id',1,'int32'),
          fieldNode('created_at',2,'.acme.common.Timestamp'),
        ],
        messages:[messageNode('Inner',{fields:[fieldNode('value',1,'string')]})],
        enums:[enumNode('Kind',[{name:'KIND_UNSPECIFIED',number:0},{name:'KIND_A',number:1}])],
        extensionRanges:[{start:100,end:200}],
      }),
    ],
  });
}

/** main.proto: package acme.main; imports base.proto (transitively common). */
function mainFile():FileNode{
  return fileNode('main.proto',{
    package:'acme.main',
    dependencies:['base.proto'],
    messages:[
      messageNode('Wrapper',{
        fields:[
          fieldNode('base',1,'acme.base.Base'),
          fieldNode('inner',2,'.acme.base.Base.Inner'),
          fieldNode('kind',3,'acme.base.Base.Kind'),
        ],
      }),
    ],
    enums:[enumNode('TopLevel',[{name:'TOP_UNSPECIFIED',number:0}])],
    services:[
      serviceNode('MainService',[
        methodNode('GetBase','acme.base.Base','.acme.main.Wrapper'),
      ]),
    ],
    extends:[
      extendNode('acme.base.Base',[fieldNode('note',100,'string')]),
    ],
  });
}

function loadAll(pool:DescriptorPool,files:FileNode[]):void{
  for(const f of files)pool.addFile(f);
}

// ---------------------------------------------------------------------
// Out-of-order loading and incremental linking
// ---------------------------------------------------------------------

describe('out-of-order loading',()=>{
  it('keeps files pending until dependencies arrive, then links incrementally',()=>{
    const pool=new DescriptorPool();

    expect(pool.addFile(mainFile())).toBeNull();
    expect(pool.isPending('main.proto')).toBe(true);
    expect(pool.missingDependenciesOf('main.proto')).toEqual(['base.proto']);

    expect(pool.addFile(baseFile())).toBeNull();
    expect(pool.isPending('base.proto')).toBe(true);
    expect(pool.isPending('main.proto')).toBe(true);

    // Arrival of the root dependency cascades through both waiting files.
    const common=pool.addFile(commonFile());
    expect(common).not.toBeNull();
    expect(pool.isLinked('common.proto')).toBe(true);
    expect(pool.isLinked('base.proto')).toBe(true);
    expect(pool.isLinked('main.proto')).toBe(true);
    expect(pool.pendingFiles()).toEqual([]);
  });

  it('produces identical descriptors regardless of arrival order',()=>{
    const orders:FileNode[][]=[
      [commonFile(),baseFile(),mainFile()],
      [mainFile(),baseFile(),commonFile()],
      [baseFile(),mainFile(),commonFile()],
      [mainFile(),commonFile(),baseFile()],
    ];
    const summaries=orders.map(files=>{
      const pool=new DescriptorPool();
      loadAll(pool,files);
      const main=pool.getFileDescriptor('main.proto')!;
      const wrapper=main.findMessageTypeByName('Wrapper')!;
      return{
        linked:pool.linkedFiles(),
        wrapperFields:wrapper.fields.map(f=>[f.name,f.messageType?.fullName??f.enumType?.fullName??f.typeName]),
        service:main.findServiceByName('MainService')!.methods.map(m=>[m.name,m.inputType?.fullName,m.outputType?.fullName]),
        extension:main.extensions.map(f=>[f.fullName,f.containingType?.fullName]),
        baseKind:pool.findEnumByName('acme.base.Base.Kind')!.values.map(v=>[v.name,v.number]),
        enumValue:pool.findSymbol('acme.base.Base.KIND_A')?.kind,
      };
    });
    for(const s of summaries)expect(s).toEqual(summaries[0]);
  });

  it('resolves cross-package references and services',()=>{
    const pool=new DescriptorPool();
    loadAll(pool,[mainFile(),commonFile(),baseFile()]);
    const main=pool.getFileDescriptor('main.proto')!;
    const wrapper=main.findMessageTypeByName('Wrapper')!;
    expect(wrapper.findFieldByName('base')!.messageType!.fullName).toBe('acme.base.Base');
    expect(wrapper.findFieldByName('inner')!.messageType!.fullName).toBe('acme.base.Base.Inner');
    expect(wrapper.findFieldByName('kind')!.enumType!.fullName).toBe('acme.base.Base.Kind');
    const method=main.findServiceByName('MainService')!.findMethodByName('GetBase')!;
    expect(method.inputType!.fullName).toBe('acme.base.Base');
    expect(method.outputType!.fullName).toBe('acme.main.Wrapper');
  });
});

// ---------------------------------------------------------------------
// Nested scopes, shadowing, relative names
// ---------------------------------------------------------------------

describe('scoping and shadowing',()=>{
  it('resolves names from the innermost scope outward',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('shadow.proto',{
      package:'p',
      messages:[
        messageNode('Outer',{
          messages:[messageNode('Inner',{fields:[fieldNode('x',1,'int32')]})],
          fields:[
            fieldNode('a',1,'Inner'),          // p.Outer.Inner
            fieldNode('b',2,'.p.Inner'),       // p.Inner (fully qualified)
            fieldNode('c',3,'Outer.Inner'),    // p.Outer.Inner from package scope
          ],
        }),
        messageNode('Inner',{fields:[fieldNode('y',1,'int32')]}),
      ],
    }));
    const outer=pool.findMessageTypeByName('p.Outer')!;
    expect(outer.findFieldByName('a')!.messageType!.fullName).toBe('p.Outer.Inner');
    expect(outer.findFieldByName('b')!.messageType!.fullName).toBe('p.Inner');
    expect(outer.findFieldByName('c')!.messageType!.fullName).toBe('p.Outer.Inner');
  });

  it('lets a nested first component shadow an outer definition even when the rest only resolves outside',()=>{
    const pool=new DescriptorPool();
    // p.Outer.Foo exists but has no Bar; p.Foo.Bar exists. C++ scoping
    // rules: "Foo.Bar" inside Outer binds Foo to p.Outer.Foo and fails.
    expect(()=>pool.addFile(fileNode('shadow2.proto',{
      package:'p',
      messages:[
        messageNode('Outer',{
          messages:[messageNode('Foo')],
          fields:[fieldNode('x',1,'Foo.Bar')],
        }),
        messageNode('Foo',{messages:[messageNode('Bar')]}),
      ],
    }))).toThrowError(SymbolLookupError);
  });

  it('reports the complete search path for unresolvable relative names',()=>{
    const pool=new DescriptorPool();
    let error:SymbolLookupError|null=null;
    try{
      pool.addFile(fileNode('bad.proto',{
        package:'a.b',
        messages:[messageNode('M',{fields:[fieldNode('x',1,'Missing.Type')]})],
      }));
    }catch(e){
      error=e as SymbolLookupError;
    }
    expect(error).toBeInstanceOf(SymbolLookupError);
    expect(error!.searchPath).toEqual(['a.b.M.Missing.Type','a.b.Missing.Type','a.Missing.Type','Missing.Type']);
    expect(error!.message).toContain('"a.b.M.Missing.Type"');
    expect(error!.message).toContain('"Missing.Type"');
  });

  it('reports the descent path when a shadowing first component matches',()=>{
    const pool=new DescriptorPool();
    let error:SymbolLookupError|null=null;
    try{
      pool.addFile(fileNode('bad2.proto',{
        package:'p',
        messages:[
          messageNode('Outer',{
            messages:[messageNode('Foo')],
            fields:[fieldNode('x',1,'Foo.Bar')],
          }),
        ],
      }));
    }catch(e){
      error=e as SymbolLookupError;
    }
    expect(error!.searchPath).toEqual(['p.Outer.Foo','p.Outer.Foo.Bar']);
  });

  it('rejects a field used where a type is expected',()=>{
    const pool=new DescriptorPool();
    expect(()=>pool.addFile(fileNode('kind.proto',{
      package:'p',
      messages:[
        messageNode('A',{fields:[fieldNode('x',1,'int32')]}),
        messageNode('B',{fields:[fieldNode('y',1,'A.x')]}),
      ],
    }))).toThrowError(SymbolKindError);
  });
});

// ---------------------------------------------------------------------
// Duplicate symbols: same-name field and type, cross-file collisions
// ---------------------------------------------------------------------

describe('duplicate symbols',()=>{
  it('rejects a field and a nested type with the same name in one message',()=>{
    const pool=new DescriptorPool();
    expect(()=>pool.addFile(fileNode('dup.proto',{
      package:'p',
      messages:[messageNode('M',{
        fields:[fieldNode('foo',1,'int32')],
        messages:[messageNode('foo')],
      })],
    }))).toThrowError(DuplicateSymbolError);
  });

  it('rejects duplicate symbols across files, even while pending',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('a.proto',{package:'p',messages:[messageNode('M')]}));
    expect(()=>pool.addFile(fileNode('b.proto',{package:'p',messages:[messageNode('M')]})))
      .toThrowError(DuplicateSymbolError);
    // The failed file was not registered; the first definition stands.
    expect(pool.findMessageTypeByName('p.M')!.file.name).toBe('a.proto');
    expect(pool.isRegistered('b.proto')).toBe(false);
  });

  it('rejects a package that collides with a declared type',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('a.proto',{package:'p',messages:[messageNode('M')]}));
    expect(()=>pool.addFile(fileNode('b.proto',{package:'p.M',messages:[messageNode('N')]})))
      .toThrowError(DuplicateSymbolError);
  });

  it('rejects duplicate enum values in the same scope',()=>{
    const pool=new DescriptorPool();
    expect(()=>pool.addFile(fileNode('dupenum.proto',{
      package:'p',
      enums:[
        enumNode('A',[{name:'X',number:0}]),
        enumNode('B',[{name:'X',number:0}]),
      ],
    }))).toThrowError(DuplicateSymbolError);
  });
});

// ---------------------------------------------------------------------
// Duplicate files
// ---------------------------------------------------------------------

describe('duplicate files',()=>{
  it('treats re-adding identical contents as a no-op',()=>{
    const pool=new DescriptorPool();
    const first=pool.addFile(commonFile());
    const second=pool.addFile(commonFile());
    expect(second).toBe(first);
    expect(pool.linkedFiles()).toEqual(['common.proto']);
  });

  it('rejects different contents under the same name',()=>{
    const pool=new DescriptorPool();
    pool.addFile(commonFile());
    const changed=commonFile();
    changed.messages.push(messageNode('Extra'));
    expect(()=>pool.addFile(changed)).toThrowError(DuplicateFileError);
  });
});

// ---------------------------------------------------------------------
// Import cycles
// ---------------------------------------------------------------------

describe('import cycles',()=>{
  it('detects direct cycles',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('a.proto',{dependencies:['b.proto']}));
    let error:DependencyCycleError|null=null;
    try{
      pool.addFile(fileNode('b.proto',{dependencies:['a.proto']}));
    }catch(e){error=e as DependencyCycleError}
    expect(error).toBeInstanceOf(DependencyCycleError);
    expect(error!.cycle).toEqual(['b.proto','a.proto','b.proto']);
  });

  it('detects indirect and self cycles',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('a.proto',{dependencies:['b.proto']}));
    pool.addFile(fileNode('b.proto',{dependencies:['c.proto']}));
    expect(()=>pool.addFile(fileNode('c.proto',{dependencies:['a.proto']})))
      .toThrowError(DependencyCycleError);
    expect(()=>pool.addFile(fileNode('self.proto',{dependencies:['self.proto']})))
      .toThrowError(DependencyCycleError);
  });
});

// ---------------------------------------------------------------------
// Public and weak imports
// ---------------------------------------------------------------------

describe('public imports',()=>{
  const leaf=()=>fileNode('leaf.proto',{package:'leaf',messages:[messageNode('Leaf')]});
  const mid=(visibility:'public'|'direct')=>fileNode('mid.proto',{
    dependencies:['leaf.proto'],
    publicDependencies:visibility==='public'?[0]:[],
  });
  const top=()=>fileNode('top.proto',{
    dependencies:['mid.proto'],
    messages:[messageNode('Top',{fields:[fieldNode('leaf_field',1,'leaf.Leaf')]})],
  });

  it('re-exports symbols through public imports',()=>{
    const pool=new DescriptorPool();
    loadAll(pool,[top(),mid('public'),leaf()]);
    expect(pool.isLinked('top.proto')).toBe(true);
    expect(pool.findMessageTypeByName('leaf.Leaf')).not.toBeNull();
    const midDesc=pool.getFileDescriptor('mid.proto')!;
    expect(midDesc.publicDependencies.map(d=>d.name)).toEqual(['leaf.proto']);
  });

  it('rejects transitive use through a plain import',()=>{
    const pool=new DescriptorPool();
    let error:NotImportedError|null=null;
    try{
      loadAll(pool,[top(),mid('direct'),leaf()]);
    }catch(e){error=e as NotImportedError}
    expect(error).toBeInstanceOf(NotImportedError);
    expect(error!.definingFile).toBe('leaf.proto');
    expect(error!.referencingFile).toBe('top.proto');
  });
});

describe('weak imports',()=>{
  const weakUser=()=>fileNode('weak-user.proto',{
    package:'w',
    dependencies:['maybe.proto'],
    weakDependencies:[0],
    messages:[messageNode('M',{fields:[fieldNode('x',1,'int32')]})],
  });

  it('links despite a missing weak import and records it',()=>{
    const pool=new DescriptorPool();
    const file=pool.addFile(weakUser());
    expect(file).not.toBeNull();
    expect(pool.isLinked('weak-user.proto')).toBe(true);
    expect(pool.missingWeakDependenciesOf('weak-user.proto')).toEqual(['maybe.proto']);
    expect(file!.dependencies).toEqual([]);
  });

  it('allows using symbols from a present weak import',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('maybe.proto',{package:'maybe',messages:[messageNode('There')]}));
    const user=weakUser();
    user.messages[0].fields.push(fieldNode('t',2,'maybe.There'));
    const file=pool.addFile(user);
    expect(file!.weakDependencies.map(d=>d.name)).toEqual(['maybe.proto']);
    expect(file!.findMessageTypeByName('M')!.findFieldByName('t')!.messageType!.fullName).toBe('maybe.There');
  });

  it('does not retroactively change a file linked without its weak import',()=>{
    const pool=new DescriptorPool();
    pool.addFile(weakUser());
    pool.addFile(fileNode('maybe.proto',{package:'maybe'}));
    expect(pool.isLinked('maybe.proto')).toBe(true);
    // The already-published descriptor is unchanged.
    expect(pool.getFileDescriptor('weak-user.proto')!.dependencies).toEqual([]);
    expect(pool.missingWeakDependenciesOf('weak-user.proto')).toEqual(['maybe.proto']);
  });
});

// ---------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------

describe('extensions',()=>{
  it('links extensions to their extendee and validates ranges',()=>{
    const pool=new DescriptorPool();
    loadAll(pool,[mainFile(),baseFile(),commonFile()]);
    const ext=pool.findExtensionByName('acme.main.note')!;
    expect(ext.isExtension).toBe(true);
    expect(ext.containingType!.fullName).toBe('acme.base.Base');
    expect(ext.extensionScope).toBeNull();
    expect(pool.getFileDescriptor('main.proto')!.extensions.map(f=>f.name)).toEqual(['note']);
  });

  it('supports extend blocks nested inside messages',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('nested-ext.proto',{
      package:'p',
      messages:[
        messageNode('Host',{extensionRanges:[{start:10,end:20}]}),
        messageNode('Holder',{
          extends:[extendNode('Host',[fieldNode('tag',10,'string')])],
        }),
      ],
    }));
    const ext=pool.findExtensionByName('p.Holder.tag')!;
    expect(ext.containingType!.fullName).toBe('p.Host');
    expect(ext.extensionScope!.fullName).toBe('p.Holder');
    expect(pool.findMessageTypeByName('p.Holder')!.extensions.map(f=>f.name)).toEqual(['tag']);
  });

  it('rejects extension numbers outside the declared ranges',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('host.proto',{package:'p',messages:[messageNode('Host',{extensionRanges:[{start:10,end:20}]})]}));
    expect(()=>pool.addFile(fileNode('ext.proto',{
      package:'p',
      dependencies:['host.proto'],
      extends:[extendNode('Host',[fieldNode('bad',99,'string')])],
    }))).toThrowError(ExtensionRangeError);
  });
});

// ---------------------------------------------------------------------
// Incremental revision replacement
// ---------------------------------------------------------------------

describe('replaceFile',()=>{
  it('replaces a pending revision and links dependents against the new one',()=>{
    const pool=new DescriptorPool();
    // dep.proto is itself blocked on a missing import, so it stays pending
    // and may be revised; user.proto waits on dep.proto.
    pool.addFile(fileNode('dep.proto',{
      package:'d',
      dependencies:['root.proto'],
      messages:[messageNode('V1')],
    }));
    pool.addFile(fileNode('user.proto',{
      package:'u',
      dependencies:['dep.proto'],
      messages:[messageNode('U',{fields:[fieldNode('v',1,'d.V2')]})],
    }));
    expect(pool.isPending('dep.proto')).toBe(true);
    expect(pool.isPending('user.proto')).toBe(true);

    // A new revision of dep.proto arrives before anything linked.
    pool.replaceFile(fileNode('dep.proto',{
      package:'d',
      dependencies:['root.proto'],
      messages:[messageNode('V2')],
    }));
    expect(pool.isPending('dep.proto')).toBe(true);

    // When the root arrives, the cascade links the new revision and the
    // dependent against it.
    pool.addFile(fileNode('root.proto',{package:'root'}));
    expect(pool.isLinked('dep.proto')).toBe(true);
    expect(pool.isLinked('user.proto')).toBe(true);
    expect(pool.findMessageTypeByName('u.U')!.findFieldByName('v')!.messageType!.fullName).toBe('d.V2');
    expect(pool.findMessageTypeByName('d.V1')).toBeNull();
  });

  it('refuses to replace a published file',()=>{
    const pool=new DescriptorPool();
    pool.addFile(commonFile());
    expect(()=>pool.replaceFile(commonFile())).toThrowError(FrozenDescriptorError);
  });
});

// ---------------------------------------------------------------------
// Immutability of published descriptors
// ---------------------------------------------------------------------

describe('immutability',()=>{
  it('freezes published descriptors against mutation',()=>{
    const pool=new DescriptorPool();
    pool.addFile(baseFile());
    pool.addFile(commonFile());
    const base=pool.getFileDescriptor('base.proto')!;
    const msg=base.findMessageTypeByName('Base')!;
    expect(base.isFrozen).toBe(true);
    expect(msg.isFrozen).toBe(true);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(msg.fields)).toBe(true);
    expect(()=>msg.addField(fieldNode('x',9,'int32')as never)).toThrowError(FrozenDescriptorError);
    expect(()=>base.addMessageType(messageNode('N')as never)).toThrowError(FrozenDescriptorError);
    expect(()=>{(base as {name:string}).name='other.proto'}).toThrow();
  });
});

// ---------------------------------------------------------------------
// Enum values and full symbol lookup
// ---------------------------------------------------------------------

describe('symbol lookup',()=>{
  it('registers enum values as siblings of the enum',()=>{
    const pool=new DescriptorPool();
    pool.addFile(baseFile());
    pool.addFile(commonFile());
    expect(pool.findSymbol('acme.base.Base.Kind')?.kind).toBe('enum');
    expect(pool.findSymbol('acme.base.Base.KIND_A')?.kind).toBe('enum-value');
    expect(pool.findSymbol('acme.base.Base.Kind.KIND_A')).toBeNull();
    expect(pool.findSymbol('.acme.base.Base')?.kind).toBe('message');
    expect(pool.findSymbol('acme.base')?.kind).toBe('package');
    expect(pool.findSymbol('acme.base.Base.id')?.kind).toBe('field');
    const value=pool.findEnumValueByName('acme.base.Base.KIND_A')!;
    expect(value.fullName).toBe('acme.base.Base.KIND_A');
    expect(value.number).toBe(1);
    expect(value.type.fullName).toBe('acme.base.Base.Kind');
  });
});

// ---------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------

describe('groups',()=>{
  it('treats a group as a nested message type plus a field',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('groups.proto',{
      package:'g',
      messages:[messageNode('M',{
        fields:[{...fieldNode('data',1,null),group:messageNode('Data',{fields:[fieldNode('x',1,'int32')]})}],
      })],
    }));
    const msg=pool.findMessageTypeByName('g.M')!;
    const field=msg.findFieldByName('data')!;
    expect(field.messageType!.fullName).toBe('g.M.Data');
    expect(msg.findNestedTypeByName('Data')!.findFieldByName('x')!.scalarType).toBe('int32');
  });
});

// ---------------------------------------------------------------------
// Order independence, exhaustively
// ---------------------------------------------------------------------

describe('order independence',()=>{
  function snapshot(pool:DescriptorPool):unknown{
    const messageSummary=(m:ReturnType<NonNullable<ReturnType<DescriptorPool['findMessageTypeByName']>>>):unknown=>({
      fullName:m.fullName,
      fields:m.fields.map(f=>[f.name,f.number,f.label,f.scalarType??f.messageType?.fullName??f.enumType?.fullName]),
      nested:m.nestedTypes.map(messageSummary),
      enums:m.enums.map(e=>[e.fullName,e.values.map(v=>[v.name,v.number])]),
      extensions:m.extensions.map(f=>[f.fullName,f.containingType?.fullName]),
      extensionRanges:m.extensionRanges,
    });
    return pool.linkedFiles().map(name=>{
      const f=pool.getFileDescriptor(name)!;
      return{
        name:f.name,
        package:f.packageName,
        deps:f.dependencies.map(d=>d.name),
        public:f.publicDependencies.map(d=>d.name),
        weak:f.weakDependencies.map(d=>d.name),
        messages:f.messageTypes.map(messageSummary),
        enums:f.enums.map(e=>[e.fullName,e.values.map(v=>[v.name,v.number])]),
        services:f.services.map(s=>[s.fullName,s.methods.map(m=>[m.name,m.inputType?.fullName,m.outputType?.fullName])]),
        extensions:f.extensions.map(x=>[x.fullName,x.containingType?.fullName]),
      };
    });
  }

  function permutations<T>(items:T[]):T[][]{
    if(items.length<=1)return[items];
    return items.flatMap((item,i)=>permutations([...items.slice(0,i),...items.slice(i+1)]).map(rest=>[item,...rest]));
  }

  it('yields identical pool state for every arrival order',()=>{
    const factories=[commonFile,baseFile,mainFile];
    const snapshots=permutations(factories).map(order=>{
      const pool=new DescriptorPool();
      for(const make of order)pool.addFile(make());
      return snapshot(pool);
    });
    for(const s of snapshots)expect(s).toEqual(snapshots[0]);
    expect(snapshots.length).toBe(6);
  });
});

// ---------------------------------------------------------------------
// Failure inspection
// ---------------------------------------------------------------------

describe('failure inspection',()=>{
  it('records permanent link failures on the file',()=>{
    const pool=new DescriptorPool();
    expect(()=>pool.addFile(fileNode('broken.proto',{
      package:'b',
      messages:[messageNode('M',{fields:[fieldNode('x',1,'nope.Nope')]})],
    }))).toThrowError(SymbolLookupError);
    expect(pool.isPending('broken.proto')).toBe(true);
    expect(pool.fileError('broken.proto')).toBeInstanceOf(SymbolLookupError);
    // A later, unrelated add does not rethrow or change the failure.
    pool.addFile(commonFile());
    expect(pool.fileError('broken.proto')).toBeInstanceOf(SymbolLookupError);
    expect(pool.isLinked('common.proto')).toBe(true);
  });

  it('treats re-adding identical pending contents as a no-op',()=>{
    const pool=new DescriptorPool();
    expect(pool.addFile(mainFile())).toBeNull();
    expect(pool.addFile(mainFile())).toBeNull();
    expect(pool.pendingFiles()).toEqual(['main.proto']);
  });
});
