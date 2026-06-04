# Spec — `@softwarity/sigwx-draw`

> Éditeur headless de cartes SIGWX (temps significatif aéronautique) pour MapLibre **et** OpenLayers.
> Pendant de `@softwarity/sigmet-draw`. Statut : spécification (v1 = démonstrateur).

## Contexte

`@softwarity/sigmet-draw` est une lib headless éprouvée pour dessiner des géométries SIGMET sur une carte (MapLibre **et** OpenLayers via un `MapAdapter`, cœur pur `core/`, sortie TAC). On veut le pendant pour les **SIGWX**.

La différence de fond : un SIGMET = **une** géométrie purement positionnelle. Un SIGWX = **une collection** de phénomènes, et surtout **les métadonnées du phénomène pilotent le rendu** :

- **jet stream** : barbules/fanions dont le **nombre et le type sont calculés** depuis `maxWindSpeed` (fanion=50kt, barbule pleine=10kt, demi=5kt) ; profondeur du jet affichée seulement si ≥120kt ; tracé seulement si ≥80kt.
- **CB** : polygone à bord **festonné** (scalloped) + label calculé depuis couverture ISOL/OCNL/FRQ, EMBD, FL top/base.
- **turbulence/CAT** : polygone à bord **tireté gras** + symbole d'intensité MOD/SEV + FL top/base.
- extensions : givrage festonné, fronts décorés triangles/demi-cercles, tropopause H/L, cyclone tropical, cendres volcaniques, radioactif, sandstorm/duststorm, freezing level, ITCZ, mountain wave.

La décoration (barbules, festons, triangles, glyphes, boîtes de label) est **dérivée** de la géométrie de base + métadonnées. C'est le cœur du nouveau module. Au-delà du dessin contraint par le phénomène, il faut des **contrôles de saisie** des métadonnées qui re-déclenchent le rendu.

## Décisions (2026-06-03, avec François)

1. **Réutilisation = copier** les adaptateurs / `MapAdapter` / `coord` depuis `sigmet-draw` (pas de monorepo, zéro risque pour le sigmet-draw publié). On reprend les patterns, pas un paquet partagé. **À l'issue de la v1**, on réétudiera la pertinence d'extraire une **lib commune** avec `sigmet-draw` (paquet partagé type `@softwarity/draw-map-kit`) : on aura alors deux usages réels des adaptateurs/`MapAdapter`/style pour juger ce qui mérite vraiment d'être mutualisé, et au prix de quelle généralisation (cf. le `LayerSpec[]` introduit ici).
2. **Formulaire = schéma + composant fourni** : la lib émet un `FormSpec` (headless) **et** ship un `<sigwx-metadata-form>` clé en main. L'hôte peut faire le sien.
3. **Périmètre v1 = noyau démonstrateur** : `jetStream` + `cb` + `turbulence`. Le reste s'ajoute **via le registry** sans toucher le contrôleur.
4. **Sortie = GeoJSON seul** : `FeatureCollection` avec métadonnées dans `properties`. Pas de modèle de chart séparé, pas de TAC, pas d'IWXXM en v1.

## Architecture cible

Headless, Terra-Draw-style (l'hôte possède la carte). Copie depuis `sigmet-draw` + **une généralisation** : le jeu d'overlays/layers passe d'un union fermé (`OverlayId`) à un **manifeste déclaratif** (`LayerSpec[]`) car SIGWX a besoin de plus de couches.

```
sigwx-draw/
  src/
    core/                         # pur, sans DOM/carte — testable sans carte
      coord.ts                    # COPIE de sigmet-draw (LatLng, parse/format lon-lat)
      phenomenon.ts               # PhenomenonDef, FieldSchema, registry  (NOUVEAU, cœur)
      registry.ts                 # registre par défaut (jet, cb, turbulence)
      decorate/                   # générateurs PURS de décoration (cœur du rendu)
        wind-barb.ts              # windBarb(point, bearing, speed) -> LineString[]
        scallop.ts                # scallopRing(ring, amp, wavelength) -> Polygon densifié
        arrowhead.ts              # tête de flèche du jet
        index.ts
      phenomena/                  # un fichier = un PhenomenonDef
        jet-stream.ts
        cb.ts
        turbulence.ts
      geojson.ts                  # save()/load() FeatureCollection + validation registry
      index.ts                    # export public du cœur
    map/
      adapter.ts                  # COPIE + généralisé : LayerSpec[] manifest, registerSymbols()
      maplibre-adapter.ts         # COPIE adaptée (sources/layers pilotés par le manifeste + sprite icônes)
      openlayers-adapter.ts       # COPIE adaptée (StyleLike par layer, Icon/Text/dash)
      sigwx-draw.ts               # contrôleur : COLLECTION de features + sélection (vs single active)
      style.ts                    # COPIE FillStyle/LineStyle/... + SigwxStyle/PhenomenonStyle
      toolbar*.ts, tooltip.ts     # COPIE (une icône par phénomène du registry)
      index.ts
    form/
      sigwx-metadata-form.ts      # web component optionnel, consomme un FormSpec
  demo/                           # Angular 21 + Vite (réutilise la coquille du demo sigmet)
```

### 1. Registry de phénomènes (grande nouveauté vs sigmet)

Chaque phénomène est déclaré **en données**. Le contrôleur, le formulaire et le pipeline de rendu lisent tout depuis le `PhenomenonDef`. Ajouter un phénomène = ajouter un objet et `registry.register()` — **aucune** modif du contrôleur.

```ts
// core/phenomenon.ts
export type GeometryPrimitive = "point" | "polyline" | "polygon";
export type PhenomenonType = "jetStream" | "cb" | "turbulence" /* + extensions */;

export type FieldSchema =
  | { type: "number"; key; label; min?; max?; step?; unit?; default?; visibleWhen?; required? }
  | { type: "fl"; key; label; default?; visibleWhen?; required? }            // FLnnn
  | { type: "enum"; key; label; options:{value;label}[]; default?; visibleWhen?; required? }
  | { type: "bool"; key; label; default?; visibleWhen? }                     // ex: EMBD
  | { type: "text"; key; label; maxLength?; visibleWhen? }
  | { type: "latlng"; key; label } | { type: "vector"; key; label };        // position / mouvement
// visibleWhen?: (m: Metadata) => boolean   -> champ masqué ET hors validation si faux

export type Metadata = Record<string, unknown>;
export type DecorateFn = (input: {
  geometry: GeoJSON.Geometry; metadata: Metadata; resolution?: number;
}) => GeoJSON.Feature[];        // PUR, engine-agnostic ; features taguées { layer, symbol?, text?, rotation? }

export interface PhenomenonDef {
  type: PhenomenonType; label: string;
  primitives: GeometryPrimitive[];
  draw: { minVertices?; maxVertices?; closed?;
          defaultGeometry: (center: LatLng, viewSpan: number) => GeoJSON.Geometry };
  schema: FieldSchema[];        // ordonné -> ordre des champs du formulaire
  decorate: DecorateFn;         // geometry + metadata -> features de décoration dérivées
  style: PhenomenonStyle;
  summary?: (m: Metadata) => string;
}
export interface PhenomenonRegistry {
  get(t: PhenomenonType): PhenomenonDef; all(): PhenomenonDef[]; register(d: PhenomenonDef): void;
}
```

**`visibleWhen`** couvre les cas SIGWX : profondeur de jet visible si `maxWindSpeed>=120`, marqueurs de changement de vitesse, etc. Le « tracé seulement si ≥80kt » est un garde dans `decorate` (axe éditable conservé, décoration supprimée).

### 2. Pipeline de décoration (le point dur)

`decorate()` renvoie un tableau plat de GeoJSON taggé par `layer`. Tout se ramène à 4 « kinds » rendables identiquement par les deux moteurs :

| kind | sortie GeoJSON | exemples |
|---|---|---|
| stroke | LineString/Polygon + token de style | axe du jet, bord tireté turbulence |
| **tessellated path** | géométrie contenant **déjà** les sommets de la décoration | feston (anneau densifié), barbules (LineStrings courts), triangles/demi-cercles fronts (polygones) |
| symbol | Point `{ symbol, rotation }` | glyphes (turb, givrage, volcan, H/L) |
| text | Point `{ text, box:true }` | boîtes FL, vitesse jet, nom cyclone |

**Décision clé (rendu engine-agnostic) :** **pré-tesséliser** festons/barbules/fronts en GeoJSON ordinaire dans `core/decorate` (pur, testable sans carte), et **ship un atlas SVG de sprites** pour le jeu fini de glyphes via une nouvelle méthode adapter `registerSymbols(sprite)`. C'est la seule voie où MapLibre (incapable de dessiner un feston via paint) et OpenLayers rendent **à l'identique**, tout en restant dans le modèle sources/layers que les deux adaptateurs implémentent déjà. (Rejeté : couche canvas/WebGL custom — casse le modèle host-owned-map.) Boîtes de texte : MapLibre `symbol`+`text-field`+halo/9-slice ; OpenLayers `Text` + `backgroundFill/Stroke` (natif).

Overlays/layers nécessaires : `selection`, `area-fill`, `edge`, `decoration`, `symbols`, `text-boxes`, `handles`.

### 3. Contrôleur — état de collection (vs single `active`)

```ts
class SigwxDraw {
  private doc: Map<string, SigwxFeature>;   // ordre d'insertion -> z-order
  private order: string[]; private selectedId: string | null;
  private dragTarget: { featureId; role } | null;
  private mode: "idle" | "placing" | "editing";
  private registry: PhenomenonRegistry;
}
type SigwxFeature = GeoJSON.Feature<GeoJSON.Geometry, {
  id: string; phenomenon: PhenomenonType; metadata: Metadata;
}>;
```

- `addPhenomenon(type)` -> crée la feature avec `def.draw.defaultGeometry()` + métadonnées par défaut du schéma -> insère, sélectionne, passe en `editing`.
- **Sélection** par hit-test (adapter `PointerEvent.hit`) sur `area`/`edge`/`symbols`. Seule la feature **sélectionnée** affiche ses handles ; les autres n'affichent que leur décoration.
- **Édition** : drag des handles mute uniquement `doc.get(selectedId).geometry` ; même UX drop-default-puis-drag-handles + throttle RAF que sigmet ; add/insert/delete de sommets (jet et fronts ont beaucoup de points) selon `def.draw`.
- **Rendu** : on vide les overlays de décoration, puis pour chaque id dans `order` on lance `def.decorate()` et on concatène dans la source d'overlay correspondante, **un `setOverlay` par overlay** (batch). Cache de décoration par feature, clé `(geometryVersion, metadataVersion)` ; on ne recalcule que la feature « dirty ».

### 4. Métadonnées ↔ formulaire

Les métadonnées vivent dans `Feature.properties.metadata` (la décoration n'est jamais stockée, toujours dérivée).

```ts
interface FormSpec {
  featureId; phenomenon: PhenomenonType;
  fields: ResolvedField[];      // schéma avec visibleWhen déjà évalué -> visible:boolean
  values: Metadata; errors: Record<string,string>;
}
sigwx.on("select",  (s: FormSpec | null) => {/* l'hôte (re)construit/efface le formulaire */});
sigwx.on("metadata",(s: FormSpec)        => {/* valeurs/visibilité/erreurs ont changé */});
// écriture : sigwx.updateMetadata(id, partial)
```

Flux d'édition : `updateMetadata` -> merge -> re-validation schéma -> ré-évaluation `visibleWhen` -> `def.decorate()` de cette feature -> push dans les overlays (RAF) -> emit `change`+`metadata`.

**Composant fourni** : `@softwarity/sigwx-draw/form` exporte `<sigwx-metadata-form>` (web component framework-agnostic) qui consomme un `FormSpec` et émet des `change` -> implémente exactement cette boucle. Optionnel (l'hôte peut faire le sien depuis le `FormSpec`).

### 5. Style / overlays

Adapter généralisé par **manifeste de layers** :
```ts
interface LayerSpec { id: string; kind: "fill"|"line"|"symbol"|"circle"; source: string; }
```
Style **par phénomène** :
```ts
interface PhenomenonStyle {
  fill?; edge?: LineStyle & { decorator?: "scallop"|"dashed"|"plain" };
  decoration?: LineStyle; symbol?: { sprite; size; color? };
  textBox?: LabelStyle & { background; border; padding }; color: string;
}
interface SigwxStyle {
  perPhenomenon: Partial<Record<PhenomenonType, PhenomenonStyle>>; base: PhenomenonStyle;
  selection: LineStyle; handle: PointStyle; controlHandle: PointStyle; tooltip: TooltipStyle;
}
```
On copie `FillStyle/LineStyle/PointStyle/LabelStyle/TooltipStyle/mergeStyle/rgba` de `sigmet-draw/src/map/style.ts`. La génération feston/tireté est dans `core/decorate` (géométrie réelle) ; le style ne fait que colorer/choisir le dash.

### 6. Sortie GeoJSON

```ts
sigwx.save(): GeoJSON.FeatureCollection   // properties = { id, phenomenon, metadata }, géométrie de base lon/lat
sigwx.load(fc): void                       // valide chaque feature contre le registry
// décorations NON sérialisées (dérivées). Méta chart (validTime, niveau) = properties de la FC ou option.
```
Pas de TAC, pas de modèle `SigwxChart` séparé, pas d'IWXXM en v1 (point d'extension `exporters/` laissé ouvert pour plus tard).

### 7. API publique

```ts
interface SigwxDrawOptions {
  adapter: MapAdapter; registry?: PhenomenonRegistry; style?: DeepPartial<SigwxStyle>;
  toolbar?: boolean | ToolbarConfig; symbolSprite?: SymbolSprite; label?: (f: SigwxFeature)=>string;
}
class SigwxDraw {
  constructor(opts); ready(): Promise<void>; destroy(): void;
  addPhenomenon(type): string; select(id|null); updateMetadata(id, patch); delete(id); clear();
  bringToFront(id); sendToBack(id);
  save(): FeatureCollection; load(fc);
  setStyle(style);
  on("change", cb:(fc)=>void); on("select", cb:(FormSpec|null)=>void); on("metadata", cb:(FormSpec)=>void); off(...);
}
```

## Fichiers de référence (sigmet-draw) à copier/adapter

- `src/map/adapter.ts` — `MapAdapter`/`PointerEvent` : copier, **généraliser** `OverlayId` -> `LayerSpec[]` + ajouter `registerSymbols()`.
- `src/map/sigwx-draw.ts` ← d'après `src/map/sigmet-draw.ts` : faire évoluer single-`active` -> collection + sélection, garder le pattern drag/RAF/emit.
- `src/map/maplibre-adapter.ts` / `openlayers-adapter.ts` — copier, ajouter layers `symbols`/`decoration`/`text-boxes` + sprite. OL : `StyleLike` par layer (`Icon`/`Text`/`Stroke` tireté). MapLibre : `addImage`+`symbol`.
- `src/map/style.ts` — copier les tokens + `mergeStyle`/`rgba`, étendre en `SigwxStyle`/`PhenomenonStyle`.
- `src/core/coord.ts` — copier tel quel.
- Build `tsc` -> ESM + d.ts, exports `.`, `./core`, `./maplibre`, `./openlayers`, `./form`. `maplibre-gl`/`ol` en peerDeps optionnels ; Turf 7 dans `core` (+ `@turf/along`, `@turf/line-chunk`, `@turf/bearing` pour barbules/densification).
- Demo Angular 21 + Vite (coquille du demo sigmet) : palette de phénomènes, panneau latéral hébergeant le `<sigwx-metadata-form>`, liste de calques (z-order/select/delete), bouton export GeoJSON.

## Périmètre v1 (démonstrateur)

3 `PhenomenonDef` complets prouvant les 3 mécaniques :

- **jetStream** (polyline) : barbules calculées depuis `maxWindSpeed`, tête de flèche, boîte FL, profondeur si ≥120kt, masqué si <80kt — prouve **métadonnées numériques -> décoration calculée**.
- **cb** (polygon) : bord festonné, label ISOL/OCNL/FRQ + EMBD + FL top/base — prouve **enum/bool -> style+label**.
- **turbulence** (polygon) : bord tireté gras, glyphe MOD/SEV, FL top/base — prouve **symbole + sprite engine-agnostic**.

Le registry, le pipeline de décoration, le manifeste de layers et le formulaire schéma-driven sont conçus pour que givrage / fronts / tropopause / cyclone / cendres / sandstorm / freezing level / ITCZ / mountain wave s'ajoutent **uniquement** comme nouveaux `PhenomenonDef`.

## Vérification

1. `npm run build` (tsc) sans erreur ; les sous-exports résolvent.
2. Tests unitaires `core/decorate` **sans carte** (vitest, comme sigmet) : `windBarb(50kt)` produit 1 fanion ; `windBarb(115kt)` = 2 fanions + 1 barbule + 1 demi ; `scallopRing` densifie le bon nombre d'arcs ; jet `<80kt` -> `decorate` renvoie `[]` ; `visibleWhen` profondeur jet bascule à 120kt.
3. Demo : sur **MapLibre ET OpenLayers**, déposer un jet, un CB, une turbulence ; vérifier rendu **identique** (barbules, feston, tireté, glyphes). Changer `maxWindSpeed` dans le formulaire -> le nombre de barbules change en direct. Sélectionner/éditer sommets, supprimer, réordonner.
4. `save()` -> FeatureCollection ; `load()` la même -> rendu identique (round-trip).

## Réserves / points ouverts

- **Refactor `OverlayId` -> manifeste** : la copie part d'un sigmet figé, donc liberté de poser directement le manifeste dans la copie (pas de migration du sigmet publié à gérer). À garder cohérent si un jour on mutualise.
- **Lib commune à réétudier après la v1** : décision explicite de différer (cf. §Décisions). Critère de décision le moment venu : quelle part des adaptateurs / `MapAdapter` / `style` est réellement identique entre les deux libs une fois SIGWX implémenté, et le coût de généralisation (manifeste de layers, `registerSymbols`, style générique) vs le bénéfice. Tant que c'est différé, garder les fichiers copiés alignés sur ceux de sigmet-draw pour faciliter une extraction ultérieure.
- **Atlas de sprites SVG** : à concevoir (glyphes MOD/SEV turbulence/givrage au minimum pour la v1). Source possible : WorldWeatherSymbolFont / symboles WMO.
- **Perf multi-features** : le cache de décoration par `(geometryVersion, metadataVersion)` est nécessaire dès qu'une carte porte beaucoup de phénomènes.

## Références SIGWX (sources)

- ICAO, *Guidelines for interpreting WAFC Significant Weather* v2.01 (Annex 3 / WMO No.49).
- NOAA Aviation Weather Center — High Level SigWx Chart Help.
- Bureau of Meteorology (AU) — *Significant Weather (SIGWX) Charts*.
- UK Met Office — *SIGWX interpretation Guide*.
- WMO BUFR FM94 / IWXXM (modèle d'échange numérique, export futur).
- WorldWeatherSymbolFont / symboles WMO (glyphes).

---

# Itération 2 — framework générique (validation d'archi par le jet réaliste)

> Déclenchée par l'analyse de la section 3.5 du *SIGWX interpretation guide v2.01* (jet streams) et l'inventaire des phénomènes 3.5→3.13. Objectif : prouver que l'archi tient pour un jet réaliste (courbe + données par segment) ET pour le pattern transverse des **call-out boxes** anti-collision.

## Taxonomie des phénomènes (guide WAFC)

| § | Phénomène | Primitive | Interaction | Métadonnées | Décorations |
|---|---|---|---|---|---|
| 3.5 | Jet | polyline **smooth+directional** | draw | global + **points de rupture {t,speed,fl,top?,base?}** | spline, barbules (côté←hémisphère), fanions, change bars, boîtes FL, extension verticale (≥120kt), flèche |
| 3.6 | Turbulence | polygon | draw | intensité MOD/SEV, base/top (XXX) | tireté gras, ombrage, symbole, **call-out** ; SEV⊂MOD |
| 3.7 | CB | polygon | draw | couverture ISOL/OCNL/FRQ, base/top | feston rouge, **call-out** |
| 3.8 | Givrage | polygon | draw | intensité, base/top | ligne T/feston, ombrage, **call-out** ; SEV⊂MOD |
| 3.9 | Tropopause | polyline (contour) + point (spot) | draw/drop | FL | contour pointillé étiqueté ; point+FL |
| 3.10 | Cyclone | point | drop | name/NN, lat/lon | symbole **NH/SH (←hémisphère)** + call-out |
| 3.11 | Volcan | point | drop | name?, lat/lon | symbole + call-out |
| 3.12 | Radioactif | point | drop | site?, lat/lon | symbole + call-out |
| 3.13 | Sandstorm | polygon (retiré 2027) | draw | base/top | symbole + aire |

## Décisions (validées avec François)

- Périmètre : **framework générique + jet refait dessus + call-out box générique appliqué à CB/turbulence**.
- Lissage : **Catmull-Rom passant par les points** d'ancrage.
- Saisie jet : **valeurs absolues par point de rupture** ; change bars (±20kt) et barbules **dérivés** des écarts.
- Barbules vs change bars : **auto + override** par point.
- Call-out : **anti-collision greedy en espace écran**, rejoué au **viewchange**, + **épinglage manuel** (drag de la boîte). Manuel > auto.

## Briques génériques à construire (A→E)

**A. Interaction déclarative + mode dessin.** `PhenomenonDef.draw.interaction = { primitive: "point"|"polyline"|"polygon", smooth?, directional?, mode: "draw"|"drop" }`. Contrôleur : états `idle|drawing|editing`. `draw` = multi-clics (clic ajoute un point ; double-clic/clic-près-du-1er = finalise ; Échap annule). `drop` = géométrie par défaut (cas points). Détection double-clic côté contrôleur ; l'adapter expose `setDoubleClickZoom(false)` pendant le dessin.

**B. Handles à 3 classes.** Features de handle taguées `hClass`: `vertex` (reshape la forme), `slider` (marqueur métier qui **glisse le long** de la courbe → recalcule `t`), et le **call-out** dont le handle EST la boîte elle-même (hit sur la couche annotations → drag = épinglage). Styles distincts par classe.

**C. Schéma structuré + sous-sélection.** Nouveau `FieldSchema` `list` (sous-records positionnés le long de la géo : points de rupture). `fl` gagne l'option `beyond` (XXX). `FormSpec` = section **global** + section **sous-élément sélectionné** (champs du point de rupture). Le contrôleur suit `selectedSub` (clic sur un slider).

**D. Helpers `core/decorate`.** `catmullRom(points, samples)` → axe lissé + fonction `t→point/tangente` ; `featherSide(lat)` (gauche NH / droite SH) ; `changeBar(point, tangent)` (deux traits ⟂) ; génération de **contenu de call-out** normalisé par type. (arrowhead/barbes/feston déjà là.)

**E. Couche annotations + anti-collision (espace écran).** Modèle `Annotation { id, ownerFeatureId, kind, anchor: LatLng, content: string[], pin?, leader }`. Les `decorate` émettent des **demandes d'annotation** (`layer:"annotations"`) ; le contrôleur les collecte globalement et lance une **passe de placement** (positions candidates px autour de l'ancre, test de chevauchement boxes+features) → émet boîtes placées (`text-boxes`) + leaders (`leaders`). Rejouée au **viewchange** (throttle RAF) sans relancer `decorate`. Épingles stockées **côté contrôleur** (Map par `featureId/labelId`, non sérialisées en v2). Leader omis si la boîte couvre l'ancre.

**Surface adapter ajoutée** : `project(LatLng)→[x,y]|null`, `onViewChange(cb)`, `setDoubleClickZoom(enabled)`, + overlays `annotations`(hit)/`leaders`, hit-test sur `text-boxes` pour le drag d'épinglage.

## Réserves it. 2
- SEV⊂MOD (turbulence/givrage) : contrainte inter-features → avis, non bloquant.
- Épingles non sérialisées en v2 (perdues au reload) ; à porter dans le GeoJSON plus tard.
- Estimation de taille de texte approximée (police px × nb caractères) faute de mesure DOM dans le cœur.
