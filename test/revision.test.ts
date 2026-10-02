import{describe,expect,it}from'vitest';
import{
  DescriptorPool,
  DependencyCycleError,
  DuplicateFileError,
  DuplicateSymbolError,
  ExtensionRangeError,
  MissingDependencyError,
  NotImportedError,
  RevisionStaleError,
  RevisionValidationError,
  SymbolLookupError,
  enumNode,
  extendNode,
  fieldNode,
  fileNode,
  messageNode,
  methodNode,
  serviceNode,
}from'../src/index.js';
import type{FileNode,MessageDescriptor,MethodDescriptor,ServiceDescriptor}from'../src/index.js';

// ---------------------------------------------------------------------
// V1 family:
//   common.proto  acme.common.Timestamp { int64 seconds }
//   base.proto    acme.base.Base (extension range 100-200), uses Timestamp
//   svc.proto     acme.svc.Svc/Echo + Req, uses Base
//   ext.proto     extension acme.base.Base.note = 100
//   misc.proto    acme.misc.Untouched (no relationship to the family)
// ---------------------------------------------------------------------

function commonV1():FileNode{
  return fileNode('common.proto',{
    package:'acme.common',
    messages:[messageNode('Timestamp',{fields:[fieldNode('seconds',1,'int64')]})],
  });
}

function baseV1():FileNode{
  return fileNode('base.proto',{
    package:'acme.base',
    dependencies:['common.proto'],
    messages:[
      messageNode('Base',{
        fields:[
          fieldNode('id',1,'int32'),
          fieldNode('created_at',2,'.acme.common.Timestamp'),
        ],
        extensionRanges:[{start:100,end:200}],
      }),
    ],
  });
}

function svcV1():FileNode{
  return fileNode('svc.proto',{
    package:'acme.svc',
    dependencies:['base.proto'],
    messages:[
      messageNode('Req',{fields:[fieldNode('base',1,'acme.base.Base')]}),
    ],
    services:[
      serviceNode('Svc',[
        methodNode('Echo','acme.base.Base','.acme.svc.Req'),
      ]),
    ],
  });
}

function extV1():FileNode{
  return fileNode('ext.proto',{
    package:'acme.ext',
    dependencies:['base.proto'],
    extends:[extendNode('acme.base.Base',[fieldNode('note',100,'string')])],
  });
}

function miscFile():FileNode{
  return fileNode('misc.proto',{
    package:'acme.misc',
    messages:[messageNode('Untouched',{fields:[fieldNode('s',1,'string')]})],
  });
}

function v1Family():FileNode[]{
  return[commonV1(),baseV1(),svcV1(),extV1(),miscFile()];
}

function loadFamily():DescriptorPool{
  const pool=new DescriptorPool();
  // Deliberately out of order: registration semantics must survive.
  for(const f of[extV1(),svcV1(),miscFile(),baseV1(),commonV1()])pool.addFile(f);
  return pool;
}

// V2: Timestamp changes type and gains a field; Base gains a field.
function commonV2():FileNode{
  return fileNode('common.proto',{
    package:'acme.common',
    messages:[messageNode('Timestamp',{fields:[
      fieldNode('seconds',1,'string'),
      fieldNode('nanos',2,'int32'),
    ]})],
  });
}

function baseV2():FileNode{
  return fileNode('base.proto',{
    package:'acme.base',
    dependencies:['common.proto'],
    messages:[
      messageNode('Base',{
        fields:[
          fieldNode('id',1,'int32'),
          fieldNode('created_at',2,'.acme.common.Timestamp'),
          fieldNode('label',3,'string'),
        ],
        extensionRanges:[{start:100,end:200}],
      }),
    ],
  });
}

// ---------------------------------------------------------------------
// Basic prepare / commit flow
// ---------------------------------------------------------------------

describe('revision prepare / commit',()=>{
  it('prepares without changing the live generation',()=>{
    const pool=loadFamily();
    const before=pool.generationId;
    const liveCommon=pool.getFileDescriptor('common.proto')!;

    const revision=pool.prepareRevision([commonV2(),baseV2()]);
    expect(revision.ok).toBe(true);
    expect(revision.failingFile).toBeNull();

    // The live pool is still serving V1.
    expect(pool.generationId).toBe(before);
    expect(pool.getFileDescriptor('common.proto')).toBe(liveCommon);
    const ts=pool.findMessageTypeByName('acme.common.Timestamp')!;
    expect(ts.findFieldByName('seconds')!.scalarType).toBe('int64');
    expect(ts.findFieldByName('nanos')).toBeNull();

    // The candidate is inspectable and already shows V2.
    const candidateTs=revision.findMessageTypeByName('acme.common.Timestamp')!;
    expect(candidateTs.findFieldByName('seconds')!.scalarType).toBe('string');
    expect(candidateTs.findFieldByName('nanos')!.number).toBe(2);
    expect(candidateTs).not.toBe(ts);
    expect(revision.findMessageTypeByName('acme.common.Timestamp')!).toBe(candidateTs);
  });

  it('publishes atomically on commit and advances the generation',()=>{
    const pool=loadFamily();
    const before=pool.generationId;
    const result=pool.commitRevisionOf([commonV2(),baseV2()]);

    expect(result.generation).toBeGreaterThan(before);
    // Batch roots plus every transitive dependent were rebuilt.
    expect(result.updatedFiles).toEqual(['base.proto','common.proto','ext.proto','svc.proto']);

    const ts=pool.findMessageTypeByName('acme.common.Timestamp')!;
    expect(ts.findFieldByName('seconds')!.scalarType).toBe('string');
    const base=pool.findMessageTypeByName('acme.base.Base')!;
    expect(base.findFieldByName('label')!.number).toBe(3);
    expect(pool.linkedFiles().sort()).toEqual(['base.proto','common.proto','ext.proto','misc.proto','svc.proto']);
  });

  it('rebuilds non-participating dependents against the new symbols',()=>{
    const pool=loadFamily();
    pool.commitRevisionOf([commonV2(),baseV2()]);

    const ts=pool.findMessageTypeByName('acme.common.Timestamp')!;
    const base=pool.findMessageTypeByName('acme.base.Base')!;
    const req=pool.findMessageTypeByName('acme.svc.Req')!;
    const service=pool.findServiceByName('acme.svc.Svc')!;
    const echo=service.findMethodByName('Echo')!;
    const note=pool.findExtensionByName('acme.ext.note')!;

    // The whole graph agrees on the new generation: no dangling old types.
    expect(base.findFieldByName('created_at')!.messageType).toBe(ts);
    expect(echo.inputType).toBe(base);
    expect(echo.outputType).toBe(req);
    expect(req.findFieldByName('base')!.messageType).toBe(base);
    expect(note.containingType).toBe(base);
  });

  it('keeps unaffected files on their existing descriptor objects',()=>{
    const pool=loadFamily();
    const misc=pool.getFileDescriptor('misc.proto')!;

    const revision=pool.prepareRevision([commonV2(),baseV2()]);
    expect(revision.ok).toBe(true);
    // misc.proto is outside the rebuild closure.
    expect(revision.getFileDescriptor('misc.proto')).toBe(misc);
    expect(revision.files().find(f=>f.name==='misc.proto')!.rebuilt).toBe(false);
    expect(revision.files().find(f=>f.name==='svc.proto')!.rebuilt).toBe(true);

    pool.commitRevision(revision);
    expect(pool.getFileDescriptor('misc.proto')).toBe(misc);
    expect(pool.findMessageTypeByName('acme.misc.Untouched')!.isFrozen).toBe(true);
  });

  it('treats a no-op batch as no generation change',()=>{
    const pool=loadFamily();
    const before=pool.generationId;
    const revision=pool.prepareRevision([commonV1()]);
    expect(revision.ok).toBe(true);
    expect(revision.updatedFiles).toEqual([]);
    const result=pool.commitRevision(revision);
    expect(result.generation).toBe(before);
    expect(result.updatedFiles).toEqual([]);
  });

  it('can introduce brand-new files in the same revision',()=>{
    const pool=loadFamily();
    const newFile=fileNode('newservice.proto',{
      package:'acme.newservice',
      dependencies:['base.proto'],
      services:[serviceNode('New',[methodNode('Ping','.acme.base.Base','.acme.base.Base')])],
    });
    pool.commitRevisionOf([commonV2(),baseV2(),newFile]);
    const ping=pool.findServiceByName('acme.newservice.New')!.findMethodByName('Ping')!;
    expect(ping.inputType).toBe(pool.findMessageTypeByName('acme.base.Base'));
  });
});

// ---------------------------------------------------------------------
// Failed revisions: the live generation survives, errors are attributed
// ---------------------------------------------------------------------

describe('failed revisions',()=>{
  it('reports which batch file broke the generation and keeps serving V1',()=>{
    const pool=loadFamily();
    const before=pool.generationId;
    const liveTs=pool.findMessageTypeByName('acme.common.Timestamp')!;
    const liveEcho=pool.findServiceByName('acme.svc.Svc')!.findMethodByName('Echo')!;

    // base.proto references a symbol the revised common.proto does not have.
    const badBase=baseV2();
    badBase.messages[0].fields.push(fieldNode('ghost',4,'.acme.common.DoesNotExist'));
    const revision=pool.prepareRevision([commonV2(),badBase]);

    expect(revision.ok).toBe(false);
    expect(revision.failingFile).toBe('base.proto');
    expect(revision.failures[0].file).toBe('base.proto');
    expect(revision.failures[0].error).toBeInstanceOf(SymbolLookupError);

    // Committing is refused; the live generation is byte-for-byte intact.
    expect(()=>pool.commitRevision(revision)).toThrowError(RevisionValidationError);
    expect(pool.generationId).toBe(before);
    expect(pool.findMessageTypeByName('acme.common.Timestamp')).toBe(liveTs);
    expect(pool.findServiceByName('acme.svc.Svc')!.findMethodByName('Echo')).toBe(liveEcho);
    expect(pool.findMessageTypeByName('acme.base.Base')!.findFieldByName('label')).toBeNull();
    // Unrelated files keep working.
    expect(pool.isLinked('misc.proto')).toBe(true);

    // The one-shot convenience throws, and the error names the file.
    expect(()=>pool.commitRevisionOf([commonV2(),badBase]))
      .toThrowError(/base\.proto/);
  });

  it('attributes a failure in a non-batch dependent to that dependent',()=>{
    const pool=loadFamily();
    // V2 Base drops the extension range; ext.proto (not in the batch) can
    // no longer link. The whole revision must fail, naming ext.proto.
    const noRanges=baseV2();
    noRanges.messages[0].extensionRanges=[];
    const revision=pool.prepareRevision([commonV2(),noRanges]);
    expect(revision.ok).toBe(false);
    expect(revision.failures.map(f=>f.file)).toContain('ext.proto');
    expect(revision.failures.find(f=>f.file==='ext.proto')!.error).toBeInstanceOf(ExtensionRangeError);
    // Nothing was published.
    expect(pool.findExtensionByName('acme.ext.note')!.containingType!.fullName).toBe('acme.base.Base');
    expect(pool.findMessageTypeByName('acme.base.Base')!.isExtensionNumber(100)).toBe(true);
  });

  it('fails on an incomplete dependency set',()=>{
    const pool=loadFamily();
    const base=baseV2();
    base.dependencies.push('newdep.proto');
    base.messages[0].fields.push(fieldNode('extra',4,'.acme.newdep.Thing'));
    const revision=pool.prepareRevision([commonV2(),base]);
    expect(revision.ok).toBe(false);
    expect(revision.failures[0].file).toBe('base.proto');
    expect(revision.failures[0].error).toBeInstanceOf(MissingDependencyError);
  });

  it('fails on duplicate symbols inside the candidate set',()=>{
    const pool=loadFamily();
    const badBase=baseV2();
    badBase.messages[0].fields.push(fieldNode('id',9,'int32'));
    const revision=pool.prepareRevision([commonV2(),badBase]);
    expect(revision.ok).toBe(false);
    expect(revision.failures[0].file).toBe('base.proto');
    expect(revision.failures[0].error).toBeInstanceOf(DuplicateSymbolError);
  });

  it('fails when the revision introduces an import cycle',()=>{
    const pool=loadFamily();
    // Make base.proto import svc.proto while svc.proto still imports base.
    const cyclicBase=baseV2();
    cyclicBase.dependencies.push('svc.proto');
    cyclicBase.messages[0].fields.push(fieldNode('back',4,'.acme.svc.Req'));
    const revision=pool.prepareRevision([cyclicBase]);
    expect(revision.ok).toBe(false);
    expect(revision.failures[0].error).toBeInstanceOf(DependencyCycleError);
    // The reported culprit is part of the submitted batch.
    expect(revision.failures[0].file).toBe('base.proto');
    expect(pool.isLinked('base.proto')).toBe(true);
  });

  it('fails when a rebuilt dependent loses visibility through a public import',()=>{
    const pool=new DescriptorPool();
    const leaf=fileNode('leaf.proto',{package:'leaf',messages:[messageNode('Leaf')]});
    const mid=fileNode('mid.proto',{
      dependencies:['leaf.proto'],publicDependencies:[0],
      package:'mid',messages:[messageNode('Mid')],
    });
    const top=fileNode('top.proto',{
      dependencies:['mid.proto'],
      package:'top',messages:[messageNode('Top',{fields:[fieldNode('l',1,'leaf.Leaf')]})],
    });
    for(const file of[top,mid,leaf])pool.addFile(file);

    // mid.proto stops re-exporting leaf.proto: top.proto must fail to link.
    const midHidden=fileNode('mid.proto',{
      dependencies:['leaf.proto'],publicDependencies:[],
      package:'mid',messages:[messageNode('Mid')],
    });
    const revision=pool.prepareRevision([midHidden]);
    expect(revision.ok).toBe(false);
    const failure=revision.failures.find(f=>f.file==='top.proto')!;
    expect(failure.error).toBeInstanceOf(NotImportedError);
    // Live graph still resolves.
    expect(pool.findMessageTypeByName('top.Top')!.findFieldByName('l')!.messageType!.fullName).toBe('leaf.Leaf');
  });

  it('rejects duplicate file names inside the batch',()=>{
    const pool=loadFamily();
    const a=commonV2();
    const b=commonV2();
    b.messages[0].fields.push(fieldNode('other',3,'int32'));
    const revision=pool.prepareRevision([a,b]);
    expect(revision.ok).toBe(false);
    expect(revision.failures.some(f=>f.file==='common.proto'&&f.error instanceof DuplicateFileError)).toBe(true);
  });

  it('lists every failing file in the validation error message',()=>{
    const pool=loadFamily();
    // Both revised files are independently invalid (in-file duplicate
    // symbols); both files must be reported in one preparation.
    const badCommon=commonV2();
    badCommon.messages.push(messageNode('Timestamp'));
    const badBase=baseV2();
    badBase.messages.push(messageNode('Base'));
    try{
      pool.commitRevisionOf([badCommon,badBase]);
      throw new Error('expected throw');
    }catch(e){
      expect(e).toBeInstanceOf(RevisionValidationError);
      const err=e as RevisionValidationError;
      expect(err.failures.length).toBeGreaterThanOrEqual(2);
      expect(err.message).toContain('common.proto');
      expect(err.message).toContain('base.proto');
    }
  });

  it('can be retried with corrected files after a failure',()=>{
    const pool=loadFamily();
    const before=pool.generationId;
    const badBase=baseV2();
    badBase.messages[0].fields.push(fieldNode('ghost',4,'.acme.common.DoesNotExist'));

    expect(pool.prepareRevision([commonV2(),badBase]).ok).toBe(false);
    expect(pool.generationId).toBe(before);

    // Fix base.proto and retry; the corrected revision commits.
    const result=pool.commitRevisionOf([commonV2(),baseV2()]);
    expect(result.generation).toBeGreaterThan(before);
    expect(pool.findMessageTypeByName('acme.common.Timestamp')!.findFieldByName('nanos')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Running-service handoff: held references stay old, queries go new
// ---------------------------------------------------------------------

describe('in-flight handoff',()=>{
  interface HeldRefs{
    base:MessageDescriptor;
    ts:MessageDescriptor;
    service:ServiceDescriptor;
    echo:MethodDescriptor;
  }

  function hold(pool:DescriptorPool):HeldRefs{
    return{
      base:pool.findMessageTypeByName('acme.base.Base')!,
      ts:pool.findMessageTypeByName('acme.common.Timestamp')!,
      service:pool.findServiceByName('acme.svc.Svc')!,
      echo:pool.findServiceByName('acme.svc.Svc')!.findMethodByName('Echo')!,
    };
  }

  it('keeps old references consistent while new queries see the new generation',()=>{
    const pool=loadFamily();
    const old=hold(pool);

    // A failed attempt happens while requests are in flight.
    const badBase=baseV2();
    badBase.messages[0].fields.push(fieldNode('ghost',4,'.acme.common.DoesNotExist'));
    expect(pool.prepareRevision([commonV2(),badBase]).ok).toBe(false);

    // Old references are unaffected by the failed attempt.
    expect(old.echo.inputType).toBe(old.base);
    expect(old.base.findFieldByName('created_at')!.messageType).toBe(old.ts);
    expect(old.ts.findFieldByName('seconds')!.scalarType).toBe('int64');
    expect(old.echo.isFrozen).toBe(true);

    // Corrected commit.
    pool.commitRevisionOf([commonV2(),baseV2()]);

    // In-flight call keeps reading V1 through its held descriptors.
    expect(old.echo.inputType).toBe(old.base);
    expect(old.echo.outputType!.findFieldByName('base')!.messageType).toBe(old.base);
    expect(old.base.findFieldByName('created_at')!.messageType).toBe(old.ts);
    expect(old.ts.findFieldByName('seconds')!.scalarType).toBe('int64');
    expect(old.ts.findFieldByName('nanos')).toBeNull();
    expect(()=>old.ts.addField?.(fieldNode('x',9,'int32')as never)).toThrow();

    // Fresh queries land on V2 and are internally consistent.
    const next=hold(pool);
    expect(next.base).not.toBe(old.base);
    expect(next.ts).not.toBe(old.ts);
    expect(next.service).not.toBe(old.service);
    expect(next.echo).not.toBe(old.echo);
    expect(next.echo.inputType).toBe(next.base);
    expect(next.base.findFieldByName('created_at')!.messageType).toBe(next.ts);
    expect(next.ts.findFieldByName('seconds')!.scalarType).toBe('string');
    expect(next.ts.findFieldByName('nanos')!.number).toBe(2);
    expect(next.base.findFieldByName('label')!.number).toBe(3);

    // Same full name, different generations.
    expect(next.base.fullName).toBe(old.base.fullName);
    expect(next.echo.fullName).toBe(old.echo.fullName);
  });

  it('does not mutate old descriptor graphs in place',()=>{
    const pool=loadFamily();
    const oldFile=pool.getFileDescriptor('base.proto')!;
    const oldDeps=oldFile.dependencies.map(d=>d.name);
    pool.commitRevisionOf([commonV2(),baseV2()]);
    expect(Object.isFrozen(oldFile)).toBe(true);
    expect(oldFile.findMessageTypeByName('Base')!.findFieldByName('label')).toBeNull();
    expect(oldFile.dependencies.map(d=>d.name)).toEqual(oldDeps);
  });
});

// ---------------------------------------------------------------------
// Batch order independence
// ---------------------------------------------------------------------

describe('revision order independence',()=>{
  function summary(pool:DescriptorPool):unknown{
    const messageSummary=(m:MessageDescriptor):unknown=>({
      fullName:m.fullName,
      fields:m.fields.map(f=>[f.name,f.number,f.scalarType??f.messageType?.fullName??f.enumType?.fullName]),
      nested:m.nestedTypes.map(messageSummary),
      enums:m.enums.map(e=>e.fullName),
      extensions:m.extensions.map(f=>[f.fullName,f.containingType?.fullName]),
      extensionRanges:m.extensionRanges,
    });
    return pool.linkedFiles().map(name=>{
      const f=pool.getFileDescriptor(name)!;
      return{
        name:f.name,
        deps:f.dependencies.map(d=>d.name),
        messages:f.messageTypes.map(messageSummary),
        services:f.services.map(s=>[s.fullName,s.methods.map(m=>[m.name,m.inputType?.fullName,m.outputType?.fullName])]),
        extensions:f.extensions.map(x=>[x.fullName,x.containingType?.fullName]),
      };
    });
  }

  it('produces the same generation for every batch ordering',()=>{
    const newFile=fileNode('helper.proto',{
      package:'acme.helper',
      dependencies:['common.proto'],
      messages:[messageNode('Helper',{fields:[fieldNode('ts',1,'.acme.common.Timestamp')]})],
    });
    const batches=[
      [commonV2(),baseV2(),newFile],
      [newFile,baseV2(),commonV2()],
      [baseV2(),newFile,commonV2()],
      [commonV2(),newFile,baseV2()],
    ];
    const snapshots=batches.map(batch=>{
      const pool=loadFamily();
      pool.commitRevisionOf(batch);
      return summary(pool);
    });
    for(const s of snapshots)expect(s).toEqual(snapshots[0]);
  });
});

// ---------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------

describe('prepared revision staleness',()=>{
  it('refuses a revision prepared against an older generation',()=>{
    const pool=loadFamily();
    const prepared=pool.prepareRevision([commonV2(),baseV2()]);

    // The pool advances while the revision is staged.
    pool.addFile(fileNode('late.proto',{package:'late',messages:[messageNode('Late')]}));

    expect(()=>pool.commitRevision(prepared)).toThrowError(RevisionStaleError);
    // Nothing half-applied.
    expect(pool.findMessageTypeByName('acme.common.Timestamp')!.findFieldByName('nanos')).toBeNull();

    // Re-prepare against the current generation and commit.
    const again=pool.prepareRevision([commonV2(),baseV2()]);
    expect(again.ok).toBe(true);
    pool.commitRevision(again);
    expect(pool.findMessageTypeByName('acme.common.Timestamp')!.findFieldByName('seconds')!.scalarType).toBe('string');
    expect(pool.isLinked('late.proto')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Pending-file semantics remain after revisions
// ---------------------------------------------------------------------

describe('pending semantics preserved',()=>{
  it('refuses to revise a still-pending file',()=>{
    const pool=loadFamily();
    pool.addFile(fileNode('soon.proto',{
      package:'soon',dependencies:['root.proto'],messages:[messageNode('Soon')],
    }));
    const revision=pool.prepareRevision([fileNode('soon.proto',{
      package:'soon',dependencies:['root.proto'],messages:[messageNode('Soon2')],
    })]);
    expect(revision.ok).toBe(false);
    expect(revision.failures[0].file).toBe('soon.proto');
  });

  it('keeps out-of-order registration and replaceFile working after a commit',()=>{
    const pool=loadFamily();
    pool.commitRevisionOf([commonV2(),baseV2()]);

    // A new chain arrives out of order after the update.
    expect(pool.addFile(fileNode('user.proto',{
      package:'u',dependencies:['dep.proto'],
      messages:[messageNode('U',{fields:[fieldNode('v',1,'d.V2')]})],
    }))).toBeNull();
    expect(pool.addFile(fileNode('dep.proto',{
      package:'d',dependencies:['root.proto'],messages:[messageNode('V1')],
    }))).toBeNull();

    // replaceFile still works on the pending file.
    pool.replaceFile(fileNode('dep.proto',{
      package:'d',dependencies:['root.proto'],messages:[messageNode('V2')],
    }));
    pool.addFile(fileNode('root.proto',{package:'root'}));
    expect(pool.linkedFiles().sort()).toContain('user.proto');
    expect(pool.findMessageTypeByName('u.U')!.findFieldByName('v')!.messageType!.fullName).toBe('d.V2');
    expect(pool.findMessageTypeByName('d.V1')).toBeNull();
  });

  it('links pending files added before the revision against the new generation',()=>{
    const pool=loadFamily();
    // A pending file waiting on a not-yet-seen dep.
    pool.addFile(fileNode('future-user.proto',{
      package:'fu',
      dependencies:['future-base.proto'],
      messages:[messageNode('FU',{fields:[fieldNode('b',1,'fb.B')]})],
    }));
    pool.commitRevisionOf([commonV2(),baseV2()]);

    pool.addFile(fileNode('future-base.proto',{
      package:'fb',
      dependencies:['base.proto'],
      messages:[messageNode('B',{fields:[fieldNode('base',1,'.acme.base.Base')]})],
    }));
    const b=pool.findMessageTypeByName('fb.B')!;
    expect(b.findFieldByName('base')!.messageType).toBe(pool.findMessageTypeByName('acme.base.Base'));
    // The pending file resolves against the V2 Base (has label).
    expect(b.findFieldByName('base')!.messageType!.findFieldByName('label')).not.toBeNull();
  });

  it('retries previously failed pending files against the new generation',()=>{
    const pool=new DescriptorPool();
    // provider.proto is linked but does not yet define the symbol.
    pool.addFile(fileNode('provider.proto',{
      package:'b',messages:[messageNode('Other',{fields:[fieldNode('z',1,'int32')]})],
    }));
    // broken.proto fails to link (unresolved type) and stays pending.
    expect(()=>pool.addFile(fileNode('broken.proto',{
      package:'b',
      dependencies:['provider.proto'],
      messages:[messageNode('M',{fields:[fieldNode('x',1,'b.Provided')]})],
    }))).toThrowError(SymbolLookupError);
    expect(pool.fileError('broken.proto')).toBeInstanceOf(SymbolLookupError);

    // Revise the linked dependency to provide the missing symbol. The
    // pending file is not part of the batch; it retries after the swap.
    const providerV2=fileNode('provider.proto',{
      package:'b',messages:[
        messageNode('Other',{fields:[fieldNode('z',1,'int32')]}),
        messageNode('Provided',{fields:[fieldNode('v',1,'int32')]}),
      ],
    });
    const revision=pool.prepareRevision([providerV2]);
    expect(revision.ok).toBe(true);
    expect(pool.isPending('broken.proto')).toBe(true);
    pool.commitRevision(revision);
    expect(pool.isLinked('broken.proto')).toBe(true);
    expect(pool.fileError('broken.proto')).toBeNull();
    expect(pool.findMessageTypeByName('b.M')!.findFieldByName('x')!.messageType!.fullName).toBe('b.Provided');
  });

  it('does not absorb pending-only symbols into a committed generation',()=>{
    const pool=loadFamily();
    pool.addFile(fileNode('waiting.proto',{
      package:'w',dependencies:['wroot.proto'],messages:[messageNode('W')],
    }));
    // Preparing while a pending file exists seeds its symbols for collision
    // checks; committing must not publish them.
    pool.commitRevisionOf([commonV2(),baseV2()]);
    expect(pool.isLinked('waiting.proto')).toBe(false);
    expect(pool.isPending('waiting.proto')).toBe(true);

    // Withdraw and replace the pending file: no dangling symbol remains.
    pool.replaceFile(fileNode('waiting.proto',{
      package:'w',dependencies:['wroot.proto'],messages:[messageNode('W2')],
    }));
    expect(pool.findSymbol('w.W')).toBeNull();
    expect(pool.findSymbol('w.W2')?.kind).toBe('message');

    pool.addFile(fileNode('wroot.proto',{package:'wroot'}));
    expect(pool.findMessageTypeByName('w.W2')).not.toBeNull();
    expect(pool.findSymbol('w.W')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Weak imports survive revisions
// ---------------------------------------------------------------------

describe('weak imports across revisions',()=>{
  it('carries the missing-weak record for unchanged files',()=>{
    const pool=new DescriptorPool();
    pool.addFile(fileNode('weak-user.proto',{
      package:'wu',
      dependencies:['maybe.proto'],
      weakDependencies:[0],
      messages:[messageNode('M',{fields:[fieldNode('x',1,'int32')]})],
    }));
    pool.addFile(fileNode('other.proto',{
      package:'wo',messages:[messageNode('O')],
    }));
    expect(pool.missingWeakDependenciesOf('weak-user.proto')).toEqual(['maybe.proto']);

    // Revise an unrelated published file; weak-user is carried over.
    pool.commitRevisionOf([fileNode('other.proto',{
      package:'wo',messages:[messageNode('O'),messageNode('O2')],
    })]);
    expect(pool.missingWeakDependenciesOf('weak-user.proto')).toEqual(['maybe.proto']);
    expect(pool.findMessageTypeByName('wu.M')).not.toBeNull();
  });
});
