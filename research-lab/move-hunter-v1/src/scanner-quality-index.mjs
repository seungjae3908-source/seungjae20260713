function frozen(v){ return Object.freeze(v); }
function nonEmpty(v){ return typeof v==='string'&&v.trim().length>0; }
function dir(v){
  const x=String(v??'').trim().toUpperCase();
  if(x==='BUY'||x==='LONG') return 'LONG';
  if(x==='SELL'||x==='SHORT') return 'SHORT';
  return null;
}
function exactKey(identity){
  return [
    identity.market,
    identity.symbol,
    identity.timeframe,
    identity.strategyProfileId,
    identity.strategyVersion,
    identity.parameterHash,
    identity.researchCodeSha,
    identity.datasetSnapshotHash,
    dir(identity.direction),
  ].join('|');
}

export function buildDirectionAwareScannerQualityIndex(packets=[]){
  if(!Array.isArray(packets)) throw new TypeError('packets must be an array');
  const byExact={};
  const bySymbol={};

  for(const packet of packets){
    if(packet?.status!=='VERIFIED_QUALITY_PACKET'||packet?.quality?.status!=='verified'){
      throw new Error('ONLY_VERIFIED_QUALITY_PACKETS_ALLOWED');
    }
    const id=packet.identity;
    if(!id||!nonEmpty(id.market)||!nonEmpty(id.symbol)||!nonEmpty(id.timeframe)||!nonEmpty(id.strategyProfileId)||!nonEmpty(id.strategyVersion)||!dir(id.direction)){
      throw new Error('QUALITY_PACKET_IDENTITY_INVALID');
    }
    const key=exactKey(id);
    if(byExact[key]) throw new Error('DUPLICATE_EXACT_QUALITY_PACKET');
    byExact[key]=packet;

    const symbolKey=String(id.symbol).toUpperCase();
    const rows=bySymbol[symbolKey]??[];
    rows.push(packet);
    bySymbol[symbolKey]=rows;
  }

  return frozen({
    schemaVersion:'move-hunter-direction-aware-quality-index/v1',
    byExact:frozen({...byExact}),
    bySymbol:frozen(Object.fromEntries(Object.entries(bySymbol).map(([k,v])=>[k,frozen([...v])]))),
    activeRankingProjectionSafe:false,
    executionAuthority:'NONE',
  });
}

export function projectQualityIndexToCurrentSymbolMap({
  cards=[],
  index,
}={}){
  if(!Array.isArray(cards)) throw new TypeError('cards must be an array');
  if(index?.schemaVersion!=='move-hunter-direction-aware-quality-index/v1') throw new TypeError('direction-aware quality index required');

  const map={};
  const blockers=[];

  for(const card of cards){
    const symbol=String(card?.symbol??'').trim().toUpperCase();
    if(!symbol){ blockers.push(frozen({code:'CARD_SYMBOL_REQUIRED'})); continue; }
    const candidates=index.bySymbol?.[symbol]??[];
    if(candidates.length===0) continue;

    const expectedDirection=dir(card.action??card.direction);
    const exact=candidates.filter(packet=>dir(packet.identity.direction)===expectedDirection);

    if(exact.length===0){
      blockers.push(frozen({
        code:'QUALITY_DIRECTION_MISSING',
        symbol,
        direction:expectedDirection,
        availableDirections:frozen([...new Set(candidates.map(p=>dir(p.identity.direction)).filter(Boolean))]),
      }));
      continue;
    }
    if(exact.length>1){
      blockers.push(frozen({code:'QUALITY_DIRECTION_AMBIGUOUS',symbol,direction:expectedDirection,count:exact.length}));
      continue;
    }

    const selected=exact[0];
    // Current ranking map is keyed only by symbol. Projection is safe only if
    // all cards for this symbol in this ranking request share the exact same identity.
    const sameSymbolCards=cards.filter(row=>String(row?.symbol??'').trim().toUpperCase()===symbol);
    const directions=[...new Set(sameSymbolCards.map(row=>dir(row.action??row.direction)).filter(Boolean))];
    if(directions.length>1){
      blockers.push(frozen({
        code:'SYMBOL_ONLY_BACKTEST_MAP_CANNOT_REPRESENT_MULTIPLE_DIRECTIONS',
        symbol,
        directions:frozen(directions),
      }));
      continue;
    }

    map[symbol]=selected.quality;
  }

  const uniqueBlockers=[];
  const seenBlockers=new Set();
  for(const blocker of blockers){
    const key=JSON.stringify(blocker);
    if(seenBlockers.has(key)) continue;
    seenBlockers.add(key);
    uniqueBlockers.push(blocker);
  }

  return frozen({
    schemaVersion:'move-hunter-current-ranking-quality-projection/v1',
    status:uniqueBlockers.length?'BLOCKED':'READY',
    backtests:uniqueBlockers.length?frozen({}):frozen({...map}),
    blockers:frozen(uniqueBlockers),
    safeForCurrentSymbolOnlyRanking:uniqueBlockers.length===0,
    activeLaneMutation:false,
    executionAuthority:'NONE',
  });
}
