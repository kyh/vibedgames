"""Observed reference specification. Runtime is a strict typed reconstruction."""
import copy
import json
import math
from pathlib import Path

root = Path(__file__).parent
spec = json.loads((root / 'spec.json').read_text())
seed = copy.deepcopy(spec['componentTree'][0])
spec['suitability'] = 'pass'
spec['coordinateFrame'] = {'front': '+Z lobby entrance', 'up': '+Y', 'scaleReference': 'Existing game-local envelope: radial distance <=4.2, y0..49.5; placement scale13/8 applied by landmarks.ts.'}
spec['silhouette'] = {'boundingShape': 'Slender continuously tapering rounded-square tower; broad curved lattice crown; recessed glass lobby.', 'aspectRatios': ['height / maximum diameter=49.5/8.4=5.893; this existing game contract wins over perspective in the reference'], 'symmetry': 'Four curved faces; single front lobby canopy breaks rotational symmetry.', 'dominantCurves': ['superellipse rounded floor plate', 'smooth upper taper increasing toward crown'], 'negativeSpaces': ['lattice crown above occupied floors', 'recessed entrance beneath canopy'], 'landmarks': ['silver horizontal sunshade grid', 'continuous vertical fins', 'blue glass panel variation', 'cool luminous crown']}
spec['performanceBudget'].update({'targetTriangles':14900, 'maxDrawCalls':6, 'textureSize':0, 'fpsTarget':60, 'optimizationPolicy':'One cached six-material kit, fresh placement groups sharing immutable buffers.32 perimeter segments and40 occupied facade bands. No per-window meshes or texture downloads.'})
spec['proceduralStrategy'] = ['Sweep a bounded32-point superellipse through explicit height stations; never scale a cylinder as final geometry.', 'Build each floor ledge with real top, outer and underside faces.', 'Sweep outward vertical fins along the same profile; glazing remains recessed behind both grid directions.', 'Continue grid above occupied floors around a translucent crown; inset roof/core below the open upper lattice.', 'Inset a dark lobby with pale canopy and dimensional entrance framing entirely within radius4.2.', 'Hand-author strict typed merged buffers from this spec; do not ship unchecked upstream internals.']
palette = {'glass':('#407d98','glass',0.3), 'lit':('#4f8194','glass',0.32), 'metal':('#cbd5d8','metal',0.42), 'crown':('#85bccd','glass',0.24), 'stone':('#d5d4cc','stone',0.72), 'dark':('#223d4a','glass',0.4)}
spec['materials'] = []
for key,(color,kind,rough) in palette.items():
 spec['materials'].append({'id':key,'name':key,'type':'standard','shaderModel':'MeshStandardMaterial','baseColor':color,'color':color,'albedo':{'dominant':color,'secondary':[color],'samplingNotes':'Reference grid-crop, crown-crop and lobby-crop material regions; preserve reflection variation as per-pane color, not baked directional lighting.'},'roughness':{'base':rough,'variation':0.02,'localResponse':'Physical ledges and fins create directional highlights; panes use bounded color variation.'},'metalness':{'base':0.18 if kind=='glass' else 0.35 if kind=='metal' else 0.0,'variation':0},'textureless':{'declared':True,'evidence':['Reference crops show smooth manufactured glass and anodized aluminum, with relief carried by the actual ledges and fins.','Stylized arcade adaptation omits microscopic photographic grain; no extracted photometric PBR accuracy is claimed.']},'localOverrides':[{'id':key+'-zones','region':'pane groups or physical ledge faces','note':'Pane colors vary deterministically; highlights and cavity contrast come from geometry and lighting. Crown and selected panes gain restrained emission at night.'}]})
spec['lightingFromPhoto'] = [{'type':'key','direction':'upper front left','color':'neutral white','intent':'Broad studio key gives silver fins bright edges and deep sunshade undersides.'},{'type':'fill','direction':'front right','color':'neutral white','intent':'Keep blue glazing legible on the darker rounded face.'},{'type':'environment','intent':'Neutral studio reflection field, exposure 1 and ACES tone mapping, light gray background and soft ground contact shadow. Game day/night lighting is reviewed separately.'}]
parts = []
def add(id, mat, size, at, level, features, primitive='box', descriptor=None):
 c=copy.deepcopy(seed)
 c.update({'id':id,'name':id,'level':level,'role':'assembled-panel','confidence':0.9,'primitive':primitive,'topologyClass':'assembled-solid','topologyRationale':'Architectural panel assembly; distinct physical glazing and shade surfaces share an explicit bounded profile.','parent':None,'attachment':None,'material':mat,'materialLayers':[mat],'fidelityTier':'blockout' if level=='macro' else 'structural-pass','localFeatures':[{'id':f,'description':f.replace('-',' ')} for f in features]})
 c['dimensions']={'width':size[0],'height':size[1],'depth':size[2],'units':'game-local','confidence':0.9}
 c['transform']={'position':at,'rotation':[0,0,0],'scale':size}
 c['geometryDescriptor']=descriptor or {'edgeTreatment':{'type':'bevel','bevelRadius':0.02,'segments':1},'normalStrategy':'face normals for projecting shade relief; smooth facade only between profile stations','uvStrategy':'none; bounded per-pane vertex colors'}
 color,kind,_=palette[mat]; rgb=[int(color[i:i+2],16) for i in (1,3,5)]; rgba='rgba('+', '.join(map(str,rgb))+', 1)'
 c['colorMaterialRecipe']={'dominantAlbedo':rgba,'secondaryAlbedo':rgba,'materialClass':kind,'materialClassConfidence':0.9,'evidenceRefs':['full-object']}
 c['actionProfile']['animationRole']='static'; c['actionProfile']['destruction']['debrisMaterial']=mat; c['actionProfile']['destruction']['fractureGroup']=id
 c['actionProfile']['collider']['notes']='No new collider: retain existing landmarks.ts protected square and height ownership; all render vertices remain in the old circular horizontal envelope.'
 parts.append(c)
profile = [[4.03-0.1*(y/49.4)-1.1*(y/49.4)**4,y] for y in [0,3.2,13,25,33,38,43.4,46,48,49.4]]
add('curtain-wall','glass',[1,1,1],[0,0,0],'macro',['rounded-corners','panel-joints'],'lathe',{'profile':profile,'radialSegments':32,'normalStrategy':'smooth profile for generator blockout; production uses a rounded-square section'})
add('lobby','dark',[6.0,3.2,6.0],[0,1.6,0],'macro',['lobby-mullions'])
add('crown','crown',[5.1,6.0,5.1],[0,46.4,0],'macro',['open-crown','crown-lights'])
add('floor-ledges','metal',[7.2,0.09,7.2],[0,3.2,0],'meso',['floor-shades'])
add('vertical-grid','metal',[0.045,46.2,0.14],[3.6,26.3,0],'meso',['vertical-fins'])
add('entrance','stone',[2.7,0.22,1.1],[0,2.45,3.15],'meso',['entrance-canopy'])
add('occupied-light-panes','lit',[0.6,0.85,0.02],[0,5,3.5],'meso',[])
spec['componentTree']=parts
spec['repetitionSystems']=[{'id':'floor-shades','buildsGeometry':True,'componentRefs':['floor-ledges'],'pattern':'closed rounded-square ledge at each facade band','count':41,'spacing':1.005},{'id':'vertical-fins','buildsGeometry':True,'componentRefs':['vertical-grid'],'pattern':'32 continuous exterior fins swept along profile stations','count':32,'spacing':0.75},{'id':'pane-variation','buildsGeometry':True,'componentRefs':['curtain-wall','occupied-light-panes'],'pattern':'32 columns by40 storey bands with deterministic lit subset','count':1280,'spacing':1.005}]
spec['featureReviewTargets']=[{'id':id,'name':name,'tier':'critical','passIds':passes,'minimumScore':0.8,'mustPass':True,'componentRefs':refs,'evidenceRefs':['full-object']} for id,name,passes,refs in [('curved-taper','Continuous rounded-square taper with broad crown',['blockout','structural-pass'],['curtain-wall','crown']),('woven-grid','Dimensional horizontal ledges and vertical fins',['form-refinement','surface-pass'],['floor-ledges','vertical-grid']),('street-lobby','Inset tall glazing and pale entrance canopy',['structural-pass','form-refinement'],['lobby','entrance']),('material-and-night','Blue glass, silver shade grid and restrained crown lighting',['material-pass','lighting-pass'],['curtain-wall','crown','occupied-light-panes'])]]
spec['reviewNotes']=['Generated reference informed silhouette, structural adjacency and material zones. Primary architectural context: https://pcparch.com/work/salesforce-tower .','Game envelope is invariant; floor count and grid spacing are exaggerated for arcade distance readability.','No unsupported animation rig or per-window draw calls. Night intensity is an explicit typed update.','Complete reference-fidelity locked pipeline is not claimed complete; production is a strict typed reconstruction inspected through real browser renders.']
(root/'spec.json').write_text(json.dumps(spec,indent=2)+'\n')
