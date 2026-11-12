export interface CharacterBinding { providerId:string;modelId:string;characterId:string;displayTier:'pro'|'standard';assetId:string }
export function resolveCharacter(bindings:CharacterBinding[],providerId:string,modelId:string){return bindings.find(b=>b.providerId===providerId&&b.modelId===modelId);}
