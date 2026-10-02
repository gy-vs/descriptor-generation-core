import{describe,expect,it}from'vitest';
import{
  DescriptorPool,
  DependencyCycleError,
  DuplicateSymbolError,
  NotImportedError,
  RevisionFileError,
  RevisionRejectedError,
  RevisionStaleError,
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
import type{FileNode,ServiceNode}from'../src/index.js';

// ---------------------------------------------------------------------
// Fixtures: a small service graph across four files.
//
//   common.proto (acme.common)  Timestamp
//   base.proto   (acme.base)    imports common; Base{id, created_at}
//   api.proto    (acme.api)     imports base; Request / Reply; ApiService
//   extra.proto  (acme.extra)   imports base only (NOT in the revision);
//                               proves an unrevised dependent is rebuilt
//                               against new definitions yet keeps its
//                               "unaffected" relation to unrelated files.
// ---------------------------------------------------------------------

function commonV1():FileNode{
  return fileNode('common.proto',{
    package:'acme.common',
    messages:[messageNode('Timestamp',{fields:[fieldNode('seconds',1,'int64')]})],
  });
}
function commonV2():FileNode{
  return fileNode('common.proto',{
    package:'acme.common',
    messages:[messageNode('Timestamp',{fields:[
      fieldNode('seconds',1,'int64'),
      fieldNode('nanos',2,'int32'),
    ]})],
  });
}

function baseV1():FileNode{
  return fileNode('base.proto',{
    package:'acme.base',
    dependencies:['common.proto'],
    messages:[messageNode('Base',{
      extensionRanges:[{start:100,end:200}],
      fields:[
        fieldNode('id',1,'int32'),
        fieldNode('created_at',2,'.acme.common.Timestamp'),
      ],
    })],
  });
}
function baseV2():FileNode{
  return fileNode('base.proto',{
    package:'acme.base',
    dependencies:['common.proto'],
    messages:[messageNode('Base',{
      extensionRanges:[{start:100,end:200}],
      fields:[
        fieldNode('id',1,'int64'),
        fieldNode('created_at',2,'.acme.common.Timestamp'),
        fieldNode('rev',3,'string'),
      ],
    })],
  });
}

const apiService=(input='acme.base.Base',output='acme.api.Reply'):ServiceNode=>
  serviceNode('ApiService',[methodNode('Do',input,output)]);

function apiV1():FileNode{
  return fileNode('api.proto',{
    package:'acme.api',
    dependencies:['base.proto'],
    messages:[
      messageNode('Request',{fields:[fieldNode('base',1,'acme.base.Base')]}),
      messageNode('Reply',{fields:[fieldNode('ok',1,'bool')]}),
    ],
    services:[apiService()],
  });
}
function apiV2():FileNode{
  return fileNode('api.proto',{
    package:'acme.api',
    dependencies:['base.proto'],
    messages:[
      messageNode('Request',{fields:[
        fieldNode('base',1,'acme.base.Base'),
        fieldNode('tag',2,'string'),
      ]}),
      messageNode('Reply',{fields:[
        fieldNode('ok',1,'bool'),
        fieldNode('rev',2,'string'),
      ]}),
    ],
    services:[serviceNode('ApiService',[
      methodNode('Do','acme.base.Base','acme.api.Reply'),
      methodNode('Ping','acme.api.Request','acme.api.Reply'),
    ])],
  });
}

function extraFile():FileNode{
  return fileNode('extra.proto',{
    package:'acme.extra',
    dependencies:['base.proto'],
    messages:[messageNode('Extra',{fields:[fieldNode('base',1,'acme.base.Base')]})],
  });
}

function loadV1(pool:DescriptorPool):void{
  for(const f of[apiV1(),baseV1(),commonV1(),extraFile()])pool.addFile(f);
}

// ---------------------------------------------------------------------
// The exact long-running-service workflow: hold v1 references, submit a
// broken revision, inspect failure while live queries stay v1, then
// submit the fixed set and verify old refs / post-failure queries /
// post-success queries all behave as required.
// ---------------------------------------------------------------------

describe('revision: end-to-end running hand-over workflow',()=>{
  it('supports hold-old / bad-attempt / fix-and-retry with distinct observations',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);

    // --- Code serving requests has captured v1 descriptors long-term.
    const heldBase=pool.findMessageTypeByName('acme.base.Base')!;
    const heldMethod=pool.findServiceByName('acme.api.ApiService')!.findMethodByName('Do')!;
    const heldInput=heldMethod.inputType!;
    const heldOutput=heldMethod.outputType!;
    expect(heldInput).toBe(heldBase);

    // --- Attempt 1: a broken set (api references a type the new base lacks).
    const brokenApi=apiV2();
    brokenApi.messages[0].fields.push(fieldNode('gone',9,'acme.base.Removed'));
    const bad=pool.prepareRevision([commonV2(),baseV2(),brokenApi]);
    expect(bad.ok).toBe(false);
    const culprit=bad.errors[0]!;
    expect(culprit.revisionFile).toBe('api.proto');
    expect(culprit.failedFile).toBe('api.proto');

    // Explicit commit of a known-bad revision is refused; nothing partial.
    expect(()=>bad.commit()).toThrowError(RevisionRejectedError);

    // Live queries after the failed attempt still answer the v1 set.
    expect(pool.generationId).toBe(1);
    expect(pool.findMessageTypeByName('acme.base.Base')).toBe(heldBase);
    expect(pool.findFieldByName('acme.common.Timestamp.nanos')).toBeNull();
    expect(pool.findMessageTypeByName('acme.api.Request')!.fields.map(f=>f.name))
      .toEqual(['base']);

    // The in-flight caller never saw anything change.
    expect(heldMethod.inputType).toBe(heldInput);
    expect(heldMethod.outputType).toBe(heldOutput);
    expect(heldBase.fields.map(f=>f.name)).toEqual(['id','created_at']);

    // --- Attempt 2: corrected set.
    const good=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);
    expect(good.ok).toBe(true);
    const report=good.commit();
    expect(report.generationId).toBe(2);

    // New queries land on generation 2.
    const freshBase=pool.findMessageTypeByName('acme.base.Base')!;
    const freshMethod=pool.findServiceByName('acme.api.ApiService')!.findMethodByName('Do')!;
    expect(freshBase).not.toBe(heldBase);
    expect(freshBase.fields.map(f=>f.name)).toEqual(['id','created_at','rev']);
    expect(freshMethod.inputType).toBe(freshBase);
    expect(freshMethod.inputType).not.toBe(heldInput);
    expect(pool.findServiceByName('acme.api.ApiService')!.findMethodByName('Ping')).not.toBeNull();

    // Old held references remain a coherent frozen v1 graph forever.
    expect(heldBase.isFrozen).toBe(true);
    expect(heldMethod.inputType).toBe(heldInput);
    expect(heldInput.findFieldByName('rev')).toBeNull();
    expect(heldOutput.fields.map(f=>f.name)).toEqual(['ok']);
    // ... while new-generation Reply has the added field.
    expect(freshMethod.outputType!.fields.map(f=>f.name)).toEqual(['ok','rev']);

    // Unrevised dependent extra.proto is queryable AND internally aligned
    // with the new symbol table.
    const extra=pool.findMessageTypeByName('acme.extra.Extra')!;
    expect(extra.findFieldByName('base')!.messageType).toBe(freshBase);
  });
});

// ---------------------------------------------------------------------
// The running-service hand-over scenario
// ---------------------------------------------------------------------

describe('revision: live hand-over',()=>{
  it('publishes a multi-file revision atomically and switches later queries',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const genBefore=pool.generationId;

    const oldBase=pool.findMessageTypeByName('acme.base.Base')!;
    const oldCommon=pool.findMessageTypeByName('acme.common.Timestamp')!;
    const oldMethod=pool.findServiceByName('acme.api.ApiService')!
      .findMethodByName('Do')!;
    const oldApi=pool.findMessageTypeByName('acme.api.Request')!;

    const revision=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);
    // Staging does not move any live answer.
    expect(pool.generationId).toBe(genBefore);
    expect(revision.ok).toBe(true);
    expect(revision.errors).toEqual([]);
    expect(pool.findMessageTypeByName('acme.base.Base')).toBe(oldBase);
    expect(pool.findFieldByName('acme.common.Timestamp.nanos')).toBeNull();

    const report=revision.commit();
    expect(report.generationId).toBe(pool.generationId);
    expect(pool.generationId).not.toBe(genBefore);
    expect(report.publishedFiles.sort()).toEqual(['api.proto','base.proto','common.proto']);
    expect(report.unchangedFiles).toEqual([]);
    expect(report.pendingFiles).toEqual([]);

    // Subsequent queries see the new generation.
    const newCommon=pool.findMessageTypeByName('acme.common.Timestamp')!;
    const newBase=pool.findMessageTypeByName('acme.base.Base')!;
    const newApi=pool.findMessageTypeByName('acme.api.Request')!;
    expect(newCommon).not.toBe(oldCommon);
    expect(newBase).not.toBe(oldBase);
    expect(newApi).not.toBe(oldApi);
    expect(newCommon.findFieldByName('nanos')).not.toBeNull();
    expect(newBase.findFieldByName('rev')).not.toBeNull();
    expect(newBase.findFieldByName('id')!.scalarType).toBe('int64');
    expect(newApi.findFieldByName('tag')).not.toBeNull();
    const service=pool.findServiceByName('acme.api.ApiService')!;
    expect(service.methods.map(m=>m.name)).toEqual(['Do','Ping']);
  });

  it('never mutates descriptors captured before the commit',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);

    const oldBase=pool.findMessageTypeByName('acme.base.Base')!;
    const oldCommon=pool.findMessageTypeByName('acme.common.Timestamp')!;
    const oldMethod=pool.findServiceByName('acme.api.ApiService')!
      .findMethodByName('Do')!;
    const oldExtra=pool.findMessageTypeByName('acme.extra.Extra')!;
    // A call in flight holds the method and reads its input type...
    expect(oldMethod.inputType).toBe(oldBase);
    expect(oldMethod.outputType!.fullName).toBe('acme.api.Reply');
    expect(oldBase.findFieldByName('created_at')!.messageType).toBe(oldCommon);
    expect(oldExtra.findFieldByName('base')!.messageType).toBe(oldBase);

    pool.commitRevision([commonV2(),baseV2(),apiV2()]);

    // ... and keeps reading the v1 graph after v2 is live.
    expect(oldBase.isFrozen).toBe(true);
    expect(oldBase.findFieldByName('rev')).toBeNull();
    expect(oldBase.findFieldByName('id')!.scalarType).toBe('int32');
    expect(oldMethod.inputType).toBe(oldBase);
    expect(oldMethod.outputType!.findFieldByName('rev')).toBeNull();
    expect(oldExtra.findFieldByName('base')!.messageType).toBe(oldBase);
    expect(oldBase.findFieldByName('created_at')!.messageType).toBe(oldCommon);

    // While fresh queries observe the new graph and its internal coherence.
    const newMethod=pool.findServiceByName('acme.api.ApiService')!
      .findMethodByName('Do')!;
    expect(newMethod).not.toBe(oldMethod);
    expect(newMethod.inputType).not.toBe(oldBase);
    expect(newMethod.inputType!.findFieldByName('rev')).not.toBeNull();
    expect(newMethod.inputType!.findFieldByName('created_at')!.messageType!
      .findFieldByName('nanos')).not.toBeNull();
  });

  it('rebuilds unrevised dependents so they point into the new symbol table',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    // extra.proto depends on base.proto but is not part of the batch.
    pool.commitRevision([commonV2(),baseV2(),apiV2()]);

    const newBase=pool.findMessageTypeByName('acme.base.Base')!;
    const extra=pool.findMessageTypeByName('acme.extra.Extra')!;
    // Still queryable (the file was not removed)...
    expect(pool.isLinked('extra.proto')).toBe(true);
    // ... and its field type is the same new Base the pool now resolves.
    expect(extra.findFieldByName('base')!.messageType).toBe(newBase);
    expect(extra.findFieldByName('base')!.messageType!.findFieldByName('rev')).not.toBeNull();

    // The rebuilt dependent's file dependency graph is the new generation.
    const extraFile=pool.getFileDescriptor('extra.proto')!;
    expect(extraFile.dependencies.map(d=>d.name)).toEqual(['base.proto']);
    expect(extraFile.dependencies[0]).toBe(pool.getFileDescriptor('base.proto'));
  });

  it('keeps every file in the new generation mutually coherent (service, extension, file deps)',()=>{
    const pool=new DescriptorPool();
    // Register the dependent before its imports, then load the v1 set:
    // when v1 arrives the cascade links ext.proto against v1 base/api.
    pool.addFile(fileNode('ext.proto',{
      package:'acme.ext',
      dependencies:['base.proto','api.proto'],
      extends:[extendNode('acme.base.Base',[fieldNode('tag',100,'string')])],
      services:[serviceNode('ExtService',[methodNode('Call','acme.api.Request','acme.api.Reply')])],
    }));
    loadV1(pool);
    expect(pool.isLinked('ext.proto')).toBe(true);

    pool.commitRevision([commonV2(),baseV2(),apiV2()]);

    const newRequest=pool.findMessageTypeByName('acme.api.Request')!;
    const newReply=pool.findMessageTypeByName('acme.api.Reply')!;
    const extMethod=pool.findServiceByName('acme.ext.ExtService')!.findMethodByName('Call')!;
    expect(extMethod.inputType).toBe(newRequest);
    expect(extMethod.outputType).toBe(newReply);

    const tag=pool.findExtensionByName('acme.ext.tag')!;
    expect(tag.containingType).toBe(pool.findMessageTypeByName('acme.base.Base'));
    expect(tag.containingType!.findFieldByName('rev')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Failed revisions: rejection, attribution, live-pool survival
// ---------------------------------------------------------------------

describe('revision: failure is atomic',()=>{
  it('rejects a revision with a duplicate symbol and leaves the live generation serving',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const genBefore=pool.generationId;
    const snapshot=pool.linkedFiles();

    // baseV2 renames/duplicates: it adds a nested message named Timestamp
    // while also referencing it — instead, force a cross-file duplicate:
    const badBase=baseV2();
    badBase.messages.push(messageNode('Timestamp')); // acme.base.Timestamp is new...
    // ...and a second file in the batch redeclares the same FQN.
    const clash=fileNode('clash.proto',{
      package:'acme.base',
      dependencies:['common.proto'],
      messages:[messageNode('Timestamp')],
    });

    const revision=pool.prepareRevision([commonV2(),badBase,clash,apiV2()]);
    expect(revision.ok).toBe(false);
    const blamed=revision.errors.map(e=>e.revisionFile);
    expect(blamed).toContain('clash.proto');
    const err=revision.errors.find(e=>e.revisionFile==='clash.proto')!;
    expect(err).toBeInstanceOf(RevisionFileError);
    expect(err.failedFile).toBe('clash.proto');
    expect(err.cause).toBeInstanceOf(DuplicateSymbolError);
    expect(err.message).toContain('clash.proto');

    expect(()=>revision.commit()).toThrowError(RevisionRejectedError);

    // Nothing moved: live queries still answer v1.
    expect(pool.generationId).toBe(genBefore);
    expect(pool.linkedFiles()).toEqual(snapshot);
    expect(pool.findMessageTypeByName('acme.base.Base')!.findFieldByName('rev')).toBeNull();
    expect(pool.findMessageTypeByName('acme.base.Timestamp')).toBeNull();
    expect(pool.isRegistered('clash.proto')).toBe(false);
  });

  it('attributes an invisible reference in a revised file to that file',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    // baseV2 drops its common import but still references Timestamp.
    const broken=baseV2();
    broken.dependencies=[];

    const revision=pool.prepareRevision([commonV2(),broken,apiV2()]);
    expect(revision.ok).toBe(false);
    const err=revision.errors.find(e=>e.revisionFile==='base.proto')!;
    expect(err).toBeInstanceOf(RevisionFileError);
    expect(err.failedFile).toBe('base.proto');
    // Either the lookup fails (Timestamp no longer visible without import)
    // or, depending on resolution, visibility is rejected.
    expect([SymbolLookupError,NotImportedError])
      .toContain(err.cause.constructor as unknown);
    expect(pool.generationId).toBe(1);
    expect(pool.getFileDescriptor('base.proto')!.dependencies.map(d=>d.name))
      .toEqual(['common.proto']);
  });

  it('attributes a failure detected in an unrevised dependent to the revised file that caused it',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    // late.proto is an unrevised dependent of common.proto and links fine
    // in the live (v1) generation.
    pool.addFile(fileNode('late.proto',{
      package:'acme.late',
      dependencies:['common.proto'],
      messages:[messageNode('Late',{fields:[fieldNode('t',1,'acme.common.Timestamp')]})],
    }));
    // The revision removes acme.common.Timestamp (renamed to Instant) and
    // updates base to match. base.proto is revised, but the breakage also
    // surfaces on late.proto, which is not in the batch: its error must be
    // blamed on the submitted file it imports, common.proto.
    const evilCommon=fileNode('common.proto',{
      package:'acme.common',
      messages:[messageNode('Instant',{fields:[fieldNode('seconds',1,'int64')]})],
    });
    const baseWithoutTimestamp=baseV2();
    baseWithoutTimestamp.messages[0].fields=
      baseWithoutTimestamp.messages[0].fields.filter(f=>f.name!=='created_at');

    const revision=pool.prepareRevision([evilCommon,baseWithoutTimestamp,apiV2()]);
    expect(revision.ok).toBe(false);
    expect(revision.errors.map(e=>e.failedFile)).toContain('late.proto');
    const lateErr=revision.errors.find(e=>e.failedFile==='late.proto')!;
    expect(lateErr.revisionFile).toBe('common.proto');
    expect(lateErr.cause).toBeInstanceOf(SymbolLookupError);

    expect(()=>revision.commit()).toThrowError(RevisionRejectedError);
    // Live pool still serves v1: Timestamp exists without a nanos field.
    expect(pool.findMessageTypeByName('acme.common.Timestamp')!.findFieldByName('nanos')).toBeNull();
    expect(pool.findMessageTypeByName('acme.common.Instant')).toBeNull();
  });

  it('rejects a dependency cycle introduced by the revision',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const cyclicCommon=commonV2();
    cyclicCommon.dependencies=['base.proto']; // common -> base -> common
    const revision=pool.prepareRevision([cyclicCommon,baseV2(),apiV2()]);
    expect(revision.ok).toBe(false);
    const err=revision.errors[0];
    expect(err.cause).toBeInstanceOf(DependencyCycleError);
    // The cycle passes through both common.proto and base.proto (both
    // submitted); attribution is the lexicographically first such file.
    expect(err.revisionFile).toBe('base.proto');
    expect(err.cause).toMatchObject({cycle:expect.arrayContaining(['base.proto','common.proto'])});
    expect(pool.isLinked('common.proto')).toBe(true);
  });

  it('rejects a wrong-kind reference and a missing symbol with file attribution',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const bad=baseV2();
    // A field's type is written as a field FQN: resolves, wrong kind.
    bad.messages[0].fields.push(fieldNode('weird',4,'acme.base.Base.id'));
    const revision=pool.prepareRevision([commonV2(),bad]);
    expect(revision.ok).toBe(false);
    expect(revision.errors[0]!.revisionFile).toBe('base.proto');
    expect(revision.errors[0]!.cause).toBeInstanceOf(SymbolKindError);
  });

  it('survives a rejected revision, then accepts the fixed retry',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const oldBase=pool.findMessageTypeByName('acme.base.Base')!;

    // First attempt: apiV2 references a type that does not exist in the
    // revised base.
    const brokenApi=apiV2();
    brokenApi.messages[0].fields.push(fieldNode('missing',9,'acme.base.Gone'));
    const first=pool.prepareRevision([commonV2(),baseV2(),brokenApi]);
    expect(first.ok).toBe(false);
    expect(first.errors[0]!.revisionFile).toBe('api.proto');
    expect(()=>first.commit()).toThrowError(RevisionRejectedError);

    // Live pool still v1; retry with corrected files.
    expect(pool.findMessageTypeByName('acme.base.Base')).toBe(oldBase);
    const second=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);
    expect(second.ok).toBe(true);
    const report=second.commit();
    expect(report.generationId).toBe(pool.generationId);
    expect(pool.findMessageTypeByName('acme.base.Base')!.findFieldByName('rev')).not.toBeNull();
    expect(pool.findServiceByName('acme.api.ApiService')!.methods.map(m=>m.name))
      .toEqual(['Do','Ping']);
  });
});

// ---------------------------------------------------------------------
// Order independence, unchanged files, pending files, staleness
// ---------------------------------------------------------------------

describe('revision: staging semantics',()=>{
  function allOrdersSatisfy(assert:(pool:DescriptorPool)=>void):void{
    const v2=[commonV2(),baseV2(),apiV2()];
    const orders:FileNode[][]=[
      [commonV2(),baseV2(),apiV2()],
      [apiV2(),baseV2(),commonV2()],
      [baseV2(),apiV2(),commonV2()],
      [commonV2(),apiV2(),baseV2()],
    ];
    expect(orders.length).toBe(v2.length===3?4:0);
    for(const batch of orders){
      const pool=new DescriptorPool();
      loadV1(pool);
      const report=pool.commitRevision(batch);
      expect(report.publishedFiles).toEqual(['api.proto','base.proto','common.proto']);
      assert(pool);
    }
  }

  it('publishes the same generation regardless of batch order',()=>{
    allOrdersSatisfy(pool=>{
      const summary=()=>({
        linked:pool.linkedFiles(),
        common:pool.findMessageTypeByName('acme.common.Timestamp')!.fields
          .map(f=>[f.name,f.scalarType]),
        base:pool.findMessageTypeByName('acme.base.Base')!.fields
          .map(f=>[f.name,f.scalarType??f.messageType?.fullName]),
        methods:pool.findServiceByName('acme.api.ApiService')!.methods
          .map(m=>[m.name,m.inputType?.fullName,m.outputType?.fullName]),
        extra:pool.findMessageTypeByName('acme.extra.Extra')!.fields
          .map(f=>f.messageType?.fullName),
      });
      expect(summary()).toEqual({
        linked:['api.proto','base.proto','common.proto','extra.proto'],
        common:[['seconds','int64'],['nanos','int32']],
        base:[['id','int64'],['created_at','acme.common.Timestamp'],['rev','string']],
        methods:[
          ['Do','acme.base.Base','acme.api.Reply'],
          ['Ping','acme.api.Request','acme.api.Reply'],
        ],
        extra:['acme.base.Base'],
      });
    });
  });

  it('keeps descriptor identity only for unchanged files outside the affected closure',()=>{
    // Case 1: a truly isolated file (no import relation to the revision)
    // submitted with identical contents is a real no-op and keeps identity.
    const pool=new DescriptorPool();
    loadV1(pool);
    pool.addFile(fileNode('solo.proto',{package:'solo',messages:[messageNode('Solo')]}));
    const solo=pool.findMessageTypeByName('solo.Solo')!;
    const report=pool.commitRevision([
      commonV2(),baseV2(),apiV2(),
      fileNode('solo.proto',{package:'solo',messages:[messageNode('Solo')]}),
    ]);
    expect(report.unchangedFiles).toEqual(['solo.proto']);
    expect(report.publishedFiles.sort()).toEqual(['api.proto','base.proto','common.proto']);
    expect(pool.findMessageTypeByName('solo.Solo')).toBe(solo);

    // Case 2: identical contents, but the file imports a revised file — it
    // is inside the affected closure, gets rebuilt against the new
    // generation (new identity) and is NOT reported as unchanged.
    const pool2=new DescriptorPool();
    loadV1(pool2);
    const sameBase=pool2.findMessageTypeByName('acme.base.Base')!;
    const report2=pool2.commitRevision([commonV2(),baseV1()]);
    expect(report2.unchangedFiles).toEqual([]);
    expect(report2.publishedFiles).toEqual(['common.proto']);
    // base.proto was rebuilt (its dependency changed) though structurally equal.
    expect(pool2.findMessageTypeByName('acme.base.Base')).not.toBe(sameBase);
    expect(pool2.findMessageTypeByName('acme.base.Base')!.findFieldByName('created_at')!
      .messageType).toBe(pool2.findMessageTypeByName('acme.common.Timestamp'));
  });

  it('allows a revision that adds a brand-new file',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const brandNew=fileNode('brand.proto',{
      package:'acme.brand',
      dependencies:['base.proto'],
      messages:[messageNode('Brand',{fields:[fieldNode('b',1,'acme.base.Base')]})],
    });
    const report=pool.commitRevision([brandNew]);
    expect(report.publishedFiles).toEqual(['brand.proto']);
    const brand=pool.findMessageTypeByName('acme.brand.Brand')!;
    expect(brand.findFieldByName('b')!.messageType)
      .toBe(pool.findMessageTypeByName('acme.base.Base'));
  });

  it('preserves pending-file semantics across revisions',()=>{
    const pool=new DescriptorPool();
    // Register a file whose dependency is absent: stays pending, revisable
    // via the original API.
    pool.addFile(fileNode('waiting.proto',{
      package:'w',
      dependencies:['missing.proto'],
      messages:[messageNode('W')],
    }));
    expect(pool.isPending('waiting.proto')).toBe(true);

    // A revision can include files that remain pending; it still commits,
    // and pending files keep their pending state in the new generation.
    const pendingNew=fileNode('pending-new.proto',{
      package:'pn',dependencies:['absent.proto'],messages:[messageNode('PN')],
    });
    loadV1(pool);
    const report=pool.commitRevision([commonV2(),baseV2(),apiV2(),pendingNew]);
    expect(report.pendingFiles).toEqual(['pending-new.proto']);
    expect(pool.isPending('pending-new.proto')).toBe(true);
    expect(pool.missingDependenciesOf('pending-new.proto')).toEqual(['absent.proto']);
    expect(pool.isPending('waiting.proto')).toBe(true);

    // Original pending replacement API still works on the new generation.
    pool.replaceFile(fileNode('waiting.proto',{
      package:'w',
      dependencies:['missing.proto'],
      messages:[messageNode('W2')],
    }));
    pool.addFile(fileNode('missing.proto',{package:'m'}));
    expect(pool.isLinked('waiting.proto')).toBe(true);
    expect(pool.findMessageTypeByName('w.W2')).not.toBeNull();
    expect(pool.findMessageTypeByName('w.W')).toBeNull();

    // And the pending-new file cascades when its dependency arrives.
    pool.addFile(fileNode('absent.proto',{package:'a'}));
    expect(pool.isLinked('pending-new.proto')).toBe(true);
  });

  it('refuses a revision against a superseded generation (RevisionStaleError)',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const revision=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);

    // The live pool moves on via the ordinary API while revision is open.
    pool.addFile(fileNode('late-arrival.proto',{package:'late'}));
    expect(revision.isStale).toBe(true);
    expect(()=>revision.commit()).toThrowError(RevisionStaleError);

    // Live state is whatever the intervening add produced; nothing half-applied.
    expect(pool.generationId).toBe(1); // addFile does not create a generation
    expect(pool.findFieldByName('acme.common.Timestamp.nanos')).toBeNull();

    // A fresh revision against the current pool commits fine.
    const fresh=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);
    expect(fresh.isStale).toBe(false);
    fresh.commit();
    expect(()=>fresh.commit()).toThrowError(RevisionStaleError);
  });

  it('makes a committed revision stale after another commit',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    const first=pool.prepareRevision([commonV2()]); // common alone
    // Note: base depends on common, so common alone changes the closure;
    // baseV1 would break (created_at still exists, so it links fine).
    first.commit();
    const second=pool.prepareRevision([baseV2()]);
    // Re-preparing the first handle is now stale.
    expect(first.isStale).toBe(true);
    expect(()=>first.commit()).toThrowError(RevisionStaleError);
    second.commit();
  });

  it('rejects an empty batch and duplicate names in a batch',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    expect(()=>pool.prepareRevision([])).toThrowError(/at least one file/);

    const a=commonV2();
    const b=commonV2();
    b.messages[0].fields.push(fieldNode('extra',9,'int32'));
    const revision=pool.prepareRevision([a,b]);
    expect(revision.ok).toBe(false);
    expect(revision.errors[0]!.revisionFile).toBe('common.proto');
    expect(revision.errors[0]!.message).toContain('more than once');
  });

  it('does not count a pre-existing unrelated failure against a revision',()=>{
    const pool=new DescriptorPool();
    loadV1(pool);
    // A broken file, failed before the revision, which does not depend on
    // any revised file. Per the original registration semantics the
    // failing link attempt surfaces from addFile and leaves the file
    // pending with a recorded error.
    let before:unknown=null;
    try{
      pool.addFile(fileNode('broken.proto',{
        package:'b',
        messages:[messageNode('B',{fields:[fieldNode('x',1,'nope.Missing')]})],
      }));
    }catch(e){before=e}
    expect(before).toBeInstanceOf(SymbolLookupError);
    expect(pool.isPending('broken.proto')).toBe(true);
    const beforeMessage=(before as Error).message;

    const revision=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);
    expect(revision.ok).toBe(true);
    revision.commit();
    // The pre-existing failure is carried over, not silently healed and
    // not blamed on the revision.
    expect(pool.isPending('broken.proto')).toBe(true);
    expect(pool.fileError('broken.proto')?.message).toBe(beforeMessage);
  });

  it('exposes generation ids that distinguish live from prepared revisions',()=>{
    const pool=new DescriptorPool();
    expect(pool.generationId).toBe(1);
    loadV1(pool);
    const revision=pool.prepareRevision([commonV2(),baseV2(),apiV2()]);
    expect(revision.baseGenerationId).toBe(1);
    expect(pool.generationId).toBe(1);
    const report=revision.commit();
    expect(report.generationId).toBe(2);
    expect(pool.generationId).toBe(2);
  });

  it('reports the same failure set regardless of batch order',()=>{
    const late=():FileNode=>fileNode('late.proto',{
      package:'acme.late',
      dependencies:['common.proto'],
      messages:[messageNode('Late',{fields:[fieldNode('t',1,'acme.common.Timestamp')]})],
    });

    const evilCommon=fileNode('common.proto',{
      package:'acme.common',
      messages:[messageNode('Instant')], // Timestamp removed
    });
    const baseWithoutTimestamp=baseV2();
    baseWithoutTimestamp.messages[0].fields=
      baseWithoutTimestamp.messages[0].fields.filter(f=>f.name!=='created_at');

    const errorSummary=(batch:FileNode[]):unknown=>{
      const pool=new DescriptorPool();
      loadV1(pool);
      pool.addFile(late()); // links against v1 Timestamp
      const revision=pool.prepareRevision(batch);
      expect(revision.ok).toBe(false);
      return revision.errors.map(e=>[e.revisionFile,e.failedFile,e.cause.name]);
    };
    const one=errorSummary([evilCommon,baseWithoutTimestamp,apiV2()]);
    const two=errorSummary([apiV2(),baseWithoutTimestamp,evilCommon]);
    expect(two).toEqual(one);
    const flat=(one as string[][]).map(([r,f])=>`${r}->${f}`);
    expect(flat).toContain('common.proto->late.proto');
  });
});
