<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import maplibregl from 'maplibre-gl';
	import { isDarkStore } from '$lib/theme';
	import { ATTRIBUTION, POLICE, rhabillerFond, styleFond } from '$lib/fond';

	let {
		selectedDate,
		layers,
		visibleLayers,
		currentData = $bindable(null),
	}: {
		selectedDate: string;
		layers: Array<{ id: string; label: string; color: string; fillColor: string; fillOpacity: number }>;
		visibleLayers: Set<string>;
		currentData?: any;
	} = $props();

	let mapContainer: HTMLDivElement;
	let miniMapContainer: HTMLDivElement;
	let map: maplibregl.Map | null = null;
	let miniMap: maplibregl.Map | null = null;
	let mapLoaded = false;
	let isDark = $state(false);
	const unsub = isDarkStore.subscribe(v => isDark = v);

	const BBOX: [[number, number], [number, number]] = [[18.87, 42.92], [42.95, 52.84]];

	// Cache fetched GeoJSON
	const cache = new Map<string, any>();

	async function fetchDateData(date: string) {
		if (cache.has(date)) return cache.get(date);
		try {
			const res = await fetch(`${import.meta.env.BASE_URL}data/ukraine-archive/${date}.geojson`);
			if (!res.ok) return null;
			const data = await res.json();
			cache.set(date, data);
			return data;
		} catch { return null; }
	}

	function updateMapData(geojson: any) {
		if (!map || !mapLoaded) return;

		for (const layerDef of layers) {
			const sourceId = `ukraine-${layerDef.id}`;
			const features = geojson
				? geojson.features.filter((f: any) => f.properties.layer === layerDef.id)
				: [];
			const fc = { type: 'FeatureCollection', features } as any;

			const source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
			if (source) {
				source.setData(fc);
			}
		}
	}

	function updateMiniMapViewport() {
		if (!map || !miniMap?.getSource('viewport')) return;
		const b = map.getBounds();
		(miniMap.getSource('viewport') as maplibregl.GeoJSONSource).setData({
			type: 'FeatureCollection',
			features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[b.getWest(), b.getSouth()], [b.getEast(), b.getSouth()], [b.getEast(), b.getNorth()], [b.getWest(), b.getNorth()], [b.getWest(), b.getSouth()]]] }, properties: {} }]
		});
	}

	// Geographic hatch lines for Crimea / pre-2022
	function generateHatchLines(polygon: number[][], spacing: number): any {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const [x, y] of polygon) {
			if (x < minX) minX = x; if (y < minY) minY = y;
			if (x > maxX) maxX = x; if (y > maxY) maxY = y;
		}
		const features: any[] = [];
		const range = Math.max(maxX - minX, maxY - minY) * 2;
		for (let d = minX - maxY - range; d <= maxX - minY + range; d += spacing) {
			const lx = Math.max(minX, d + minY), rx = Math.min(maxX, d + maxY);
			if (lx >= rx) continue;
			const segs = clipLine(lx, rx, d, polygon);
			for (const seg of segs) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: seg }, properties: {} });
		}
		return { type: 'FeatureCollection', features };
	}

	function clipLine(xMin: number, xMax: number, d: number, polygon: number[][]): number[][][] {
		const step = 0.005, segments: number[][][] = [];
		let current: number[][] = [];
		for (let x = xMin; x <= xMax; x += step) {
			const y = x - d;
			if (pip(x, y, polygon)) { current.push([x, y]); }
			else if (current.length > 0) { if (current.length >= 2) segments.push(current); current = []; }
		}
		if (current.length >= 2) segments.push(current);
		return segments;
	}

	function pip(x: number, y: number, poly: number[][]): boolean {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
			if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
		}
		return inside;
	}

	onMount(() => {
		map = new maplibregl.Map({
			container: mapContainer,
			style: styleFond(isDark),
			maxZoom: 14,
			minZoom: 3,
			cooperativeGestures: true,
			attributionControl: false
		});

		map.addControl(new maplibregl.NavigationControl(), 'top-right');
		map.addControl(new maplibregl.ScaleControl({ maxWidth: 150, unit: 'metric' }), 'bottom-right');
		map.addControl(new maplibregl.AttributionControl({ customAttribution: ATTRIBUTION }), 'bottom-right');
		const attribEl = mapContainer.querySelector('.maplibregl-ctrl-attrib');
		if (attribEl) {
			attribEl.classList.add('maplibregl-compact');
			new MutationObserver(() => {
				if (!attribEl.classList.contains('maplibregl-compact')) {
					attribEl.classList.add('maplibregl-compact');
				}
			}).observe(attribEl, { attributes: true, attributeFilter: ['class'] });
		}

		// Fit bbox to container, choosing the tighter dimension
		const ro = new ResizeObserver(() => {
			const h = mapContainer.clientHeight;
			const w = mapContainer.clientWidth;
			if (!h || !w) return;
			const toRad = Math.PI / 180;
			const yMin = Math.log(Math.tan(toRad * BBOX[0][1] / 2 + Math.PI / 4));
			const yMax = Math.log(Math.tan(toRad * BBOX[1][1] / 2 + Math.PI / 4));
			const mercatorSpanY = yMax - yMin;
			const lngSpan = BBOX[1][0] - BBOX[0][0];
			const zoomH = Math.log2((h * 2 * Math.PI) / (512 * mercatorSpanY));
			const zoomW = Math.log2((w * 360) / (512 * lngSpan));
			const zoom = Math.min(zoomH, zoomW);
			const centerLng = (BBOX[0][0] + BBOX[1][0]) / 2;
			const centerLat = (BBOX[0][1] + BBOX[1][1]) / 2;
			map!.jumpTo({ center: [centerLng, centerLat], zoom });
			// Lock maxBounds to the actual visible area so user can't pan vertically
			const bounds = map!.getBounds();
			map!.setMaxBounds(bounds);
			ro.disconnect();
		});
		ro.observe(mapContainer);


		map.on('load', () => {
			mapLoaded = true;

			// Add empty sources for data layers
			for (const layerDef of layers) {
				const sourceId = `ukraine-${layerDef.id}`;
				map!.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any });
				map!.addLayer({ id: `${sourceId}-fill`, type: 'fill', source: sourceId, paint: { 'fill-color': layerDef.fillColor, 'fill-opacity': layerDef.fillOpacity } });
			}

			// Ukraine oblasts
			fetch(`${import.meta.env.BASE_URL}data/ukraine-oblasts.json`)
				.then(r => r.json())
				.then(oblasts => {
					if (!map) return;
					map.addSource('ukraine-oblasts', { type: 'geojson', data: oblasts });
					map.addLayer({ id: 'ukraine-oblasts-line', type: 'line', source: 'ukraine-oblasts', paint: { 'line-color': isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)', 'line-width': 0.8, 'line-dasharray': [4, 3] } });
				}).catch(() => {});

// Crimea hatched overlay
			fetch(`${import.meta.env.BASE_URL}data/crimea.json`)
				.then(r => r.json())
				.then(crimea => {
					if (!map) return;
					const ring = crimea.geometry.coordinates[0];
					const hatchLines = generateHatchLines(ring, 0.12);
					map.addSource('crimea', { type: 'geojson', data: crimea });
					map.addLayer({ id: 'crimea-fill', type: 'fill', source: 'crimea', paint: { 'fill-color': '#991b1b', 'fill-opacity': 0.05 } });
					map.addLayer({ id: 'crimea-line', type: 'line', source: 'crimea', paint: { 'line-color': '#991b1b', 'line-width': 1.5, 'line-opacity': 0.4 } });
					map.addSource('crimea-hatch', { type: 'geojson', data: hatchLines });
					map.addLayer({ id: 'crimea-hatch-lines', type: 'line', source: 'crimea-hatch', paint: { 'line-color': isDark ? '#dc2626' : '#991b1b', 'line-width': 0.8, 'line-opacity': isDark ? 0.5 : 0.35 } });
				}).catch(() => {});

			// Pre-2022 DPR/LPR hatched overlay
			fetch(`${import.meta.env.BASE_URL}data/pre2022_russian_control.json`)
				.then(r => r.json())
				.then(pre2022 => {
					if (!map) return;
					const allHatch: any = { type: 'FeatureCollection', features: [] };
					const coords = pre2022.geometry.type === 'MultiPolygon' ? pre2022.geometry.coordinates : [pre2022.geometry.coordinates];
					for (const poly of coords) {
						const ring = poly[0];
						const hatch = generateHatchLines(ring, 0.12);
						allHatch.features.push(...hatch.features);
					}
					map.addSource('pre2022', { type: 'geojson', data: pre2022 });
					map.addLayer({ id: 'pre2022-fill', type: 'fill', source: 'pre2022', paint: { 'fill-color': '#991b1b', 'fill-opacity': 0.05 } });
					map.addLayer({ id: 'pre2022-line', type: 'line', source: 'pre2022', paint: { 'line-color': '#991b1b', 'line-width': 1.5, 'line-opacity': 0.4 } });
					map.addSource('pre2022-hatch', { type: 'geojson', data: allHatch });
					map.addLayer({ id: 'pre2022-hatch-lines', type: 'line', source: 'pre2022-hatch', paint: { 'line-color': isDark ? '#dc2626' : '#991b1b', 'line-width': 0.8, 'line-opacity': isDark ? 0.5 : 0.35 } });
				}).catch(() => {});

			// Country labels
			map!.addSource('country-labels', {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [32.0, 49.0] }, properties: { name: 'UKRAINE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [38.0, 51.0] }, properties: { name: 'RUSSIE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [27.52, 52.11] }, properties: { name: 'BIÉLORUSSIE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [19.4, 51.9] }, properties: { name: 'POLOGNE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [25.0, 45.9] }, properties: { name: 'ROUMANIE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [19.7, 48.7] }, properties: { name: 'SLOVAQUIE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [28.8, 47.0] }, properties: { name: 'MOLDAVIE' } },
					{ type: 'Feature', geometry: { type: 'Point', coordinates: [20.3, 47.5] }, properties: { name: 'HONGRIE' } },
				]}
			});
			map!.addLayer({ id: 'country-labels-text', type: 'symbol', source: 'country-labels',
				layout: { 'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 6, 14, 10, 18], 'text-font': POLICE, 'text-transform': 'uppercase', 'text-letter-spacing': 0.15, 'text-allow-overlap': false },
				paint: { 'text-color': isDark ? '#777' : '#999', 'text-halo-color': isDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)', 'text-halo-width': 1.5 }
			});

			// Kyiv marker
			const kyivEl = document.createElement('div');
			kyivEl.className = 'kyiv-marker';
			kyivEl.innerHTML = '<span class="kyiv-square"></span><span class="kyiv-label">Kyiv</span>';
			new maplibregl.Marker({ element: kyivEl, anchor: 'left' })
				.setLngLat([30.523333, 50.450001])
				.addTo(map!);

			// Crimea label
			const crimeaEl = document.createElement('div');
			crimeaEl.className = 'crimea-marker';
			crimeaEl.innerHTML = '<span class="crimea-map-label">Crimée<br>annexée<br>en 2014</span>';
			new maplibregl.Marker({ element: crimeaEl, anchor: 'center' })
				.setLngLat([34.1, 45.3])
				.addTo(map!);

			// Load initial date
			fetchDateData(selectedDate).then(d => { if (d) { updateMapData(d); currentData = d; } });
		});

		// Mini map
		miniMap = new maplibregl.Map({
			container: miniMapContainer,
			style: styleFond(isDark, true),
			center: [31, 49], zoom: 0, interactive: false, attributionControl: false
		});

		miniMap.on('load', () => {
			miniMap!.addSource('viewport', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
			miniMap!.addLayer({ id: 'viewport-fill', type: 'fill', source: 'viewport', paint: { 'fill-color': '#4a9eff', 'fill-opacity': 0.15 } });
			miniMap!.addLayer({ id: 'viewport-line', type: 'line', source: 'viewport', paint: { 'line-color': '#4a9eff', 'line-width': 1.5 } });
			map!.on('move', updateMiniMapViewport);
			updateMiniMapViewport();
		});
	});

	onDestroy(() => { map?.remove(); miniMap?.remove(); unsub(); });

	// React to theme changes
	$effect(() => {
		const dark = isDark;
		if (!map || !mapLoaded) return;
		map.setPaintProperty('background', 'background-color', dark ? '#0e0e0e' : '#FAFAF8');
		map.setPaintProperty('water', 'fill-color', dark ? '#262626' : '#D4DADC');
		map.setPaintProperty('boundary_state', 'line-color', dark ? '#ffffff' : '#000000');
		map.setPaintProperty('boundary_state', 'line-opacity', dark ? 0.5 : 0.6);
if (map.getLayer('ukraine-oblasts-line')) map.setPaintProperty('ukraine-oblasts-line', 'line-color', dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)');
		if (map.getLayer('crimea-hatch-lines')) {
			map.setPaintProperty('crimea-hatch-lines', 'line-color', dark ? '#dc2626' : '#991b1b');
			map.setPaintProperty('crimea-hatch-lines', 'line-opacity', dark ? 0.5 : 0.35);
		}
		if (map.getLayer('pre2022-hatch-lines')) {
			map.setPaintProperty('pre2022-hatch-lines', 'line-color', dark ? '#dc2626' : '#991b1b');
			map.setPaintProperty('pre2022-hatch-lines', 'line-opacity', dark ? 0.5 : 0.35);
		}
		if (map.getLayer('country-labels-text')) {
			map.setPaintProperty('country-labels-text', 'text-color', dark ? '#777' : '#999');
			map.setPaintProperty('country-labels-text', 'text-halo-color', dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)');
		}
		if (miniMap?.isStyleLoaded()) rhabillerFond(miniMap, dark, true);
	});

	// React to date changes
	$effect(() => {
		const date = selectedDate;
		if (!mapLoaded) return;
		fetchDateData(date).then(d => { if (d) { updateMapData(d); currentData = d; } });
	});

	// React to layer visibility changes
	$effect(() => {
		const visible = visibleLayers;
		if (!map || !mapLoaded) return;
		for (const layerDef of layers) {
			const sourceId = `ukraine-${layerDef.id}`;
			const visibility = visible.has(layerDef.id) ? 'visible' : 'none';
			if (map.getLayer(`${sourceId}-fill`)) map.setLayoutProperty(`${sourceId}-fill`, 'visibility', visibility);
		}
	});
</script>

<div bind:this={mapContainer} class="map"></div>
<div class="minimap-wrapper">
	<div bind:this={miniMapContainer} class="minimap"></div>
</div>

<style>
	.map { width: 100%; height: 100%; position: absolute; top: 0; left: 0; }
	.minimap-wrapper { position: absolute; bottom: 6px; left: 16px; width: 140px; height: 140px; border-radius: 50%; overflow: hidden; border: 2px solid var(--border); box-shadow: 0 4px 16px rgba(0,0,0,0.3); z-index: 10; }
	@media (max-width: 768px) { .minimap-wrapper { width: 90px; height: 90px; bottom: 6px; left: 10px; } }
	.minimap { width: 100%; height: 100%; }
	:global(.minimap-wrapper .maplibregl-canvas) { border-radius: 50%; }

	:global(.kyiv-marker) { display: flex; align-items: center; gap: 5px; pointer-events: none; z-index: 5; margin-left: -3.5px; margin-top: -3.5px; }
	:global(.kyiv-square) { width: 7px; height: 7px; background: var(--text); flex-shrink: 0; }
	:global(.kyiv-label) { font-family: 'Montserrat', sans-serif; font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
	:global(.crimea-marker) { pointer-events: none; z-index: 5; display: flex; justify-content: center; }
	:global(.crimea-map-label) { font-family: 'Montserrat', sans-serif; font-size: 10px; font-weight: 500; font-style: italic; color: var(--text); text-align: center; line-height: 1.3; text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8); }
</style>
