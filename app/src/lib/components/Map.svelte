<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import maplibregl from 'maplibre-gl';
	import type { StrikeData, LayerMeta } from '$lib/types';
	import { t } from '$lib/i18n';
	import { isDarkStore } from '$lib/theme';
	import { ATTRIBUTION, POLICE, POLICE_GRASSE, rhabillerFond, styleFond } from '$lib/fond';

	let {
		data,
		selectedDate,
		visibleLayers,
		showAnnotations,
		cumulative,
		initialBounds = null,
		getCurrentBounds = $bindable(null)
	}: {
		data: StrikeData;
		selectedDate: string;
		visibleLayers: Set<string>;
		showAnnotations: boolean;
		cumulative: boolean;
		initialBounds?: [number, number, number, number] | null;
		getCurrentBounds?: (() => [number, number, number, number] | null) | null;
	} = $props();

	let mapContainer: HTMLDivElement;
	let miniMapContainer: HTMLDivElement;
	let map: maplibregl.Map | null = null;
	let miniMap: maplibregl.Map | null = null;
	let popup: maplibregl.Popup | null = null;
	let annotationLayerIds: string[] = [];
	let isDark = $state(false);
	const unsub = isDarkStore.subscribe(v => isDark = v);

	function clearHighlight() {
		if (map?.getSource('highlight')) {
			(map.getSource('highlight') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
		}
	}

	// Bounding box from the data (with padding)
	const DATA_BOUNDS: [number, number, number, number] = [28, 18, 66, 42];

	// Country labels in French with approximate centroids
	const COUNTRY_LABELS: { name: string; lng: number; lat: number }[] = [
		{ name: 'Iran', lng: 53.5, lat: 32.5 },
		{ name: 'Irak', lng: 43.5, lat: 33.2 },
		{ name: 'Liban', lng: 35.9, lat: 33.9 },
		{ name: 'Syrie', lng: 38.5, lat: 35.0 },
		{ name: 'Turquie', lng: 35.0, lat: 39.0 },
		{ name: 'Arabie\nSaoudite', lng: 45.0, lat: 24.0 },
		{ name: 'Israël', lng: 34.8, lat: 31.5 },
		{ name: 'Jordanie', lng: 36.5, lat: 31.2 },
		{ name: 'Koweït', lng: 47.5, lat: 29.3 },
		{ name: 'Bahreïn', lng: 50.5, lat: 26.1 },
		{ name: 'Qatar', lng: 51.2, lat: 25.3 },
		{ name: 'É.A.U.', lng: 54.5, lat: 24.0 },
		{ name: 'Oman', lng: 57.0, lat: 21.5 },
		{ name: 'Pakistan', lng: 63.0, lat: 28.0 },
		{ name: 'Afghanistan', lng: 65.0, lat: 34.0 },
		{ name: 'Égypte', lng: 30.0, lat: 27.0 },
		{ name: 'Yémen', lng: 48.0, lat: 15.5 },
	];

	function buildGeoJSON(date: string, visible: Set<string>): GeoJSON.FeatureCollection {
		const features: GeoJSON.Feature[] = [];
		for (const f of data.features) {
			const match = cumulative ? f.date <= date : f.date === date;
			if (!match || !visible.has(f.layer)) continue;
			features.push({
				type: 'Feature',
				geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
				properties: {
					layer: f.layer,
					date: f.date,
					city: f.city,
					type: f.type,
					actor: f.actor,
					country: f.country,
					province: f.province,
					siteType: f.siteType,
					source: f.source,
					vessel: f.vessel,
					flag: f.flag
				}
			});
		}
		return { type: 'FeatureCollection', features };
	}

	function buildCountryLabelsGeoJSON(): GeoJSON.FeatureCollection {
		return {
			type: 'FeatureCollection',
			features: COUNTRY_LABELS.map(c => ({
				type: 'Feature' as const,
				geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] },
				properties: { name: c.name }
			}))
		};
	}

	function getColorExpression(layers: LayerMeta[]): maplibregl.ExpressionSpecification {
		const stops: (string | maplibregl.ExpressionSpecification)[] = ['match', ['get', 'layer']];
		for (const l of layers) {
			stops.push(l.id, l.color);
		}
		stops.push('#888');
		return stops as maplibregl.ExpressionSpecification;
	}

	// ── Annotations ────────────────────────────────────────────────

	interface AnnCircle {
		id: string;
		coordinates: number[][];
		color: string;
		opacity?: number;
		fillOpacity?: number;
		dasharray?: number[];
		width?: number;
	}

	interface AnnArrow {
		id: string;
		from: [number, number];
		to: [number, number];
		curve: number;
		color: string;
		width?: number;
		opacity?: number;
		label?: string;
		labelPosition?: 'start' | 'middle' | 'end';
		labelAnchor?: string;
		fontSize?: number;
		mobileFrom?: [number, number];
		mobileTo?: [number, number];
		mobileCurve?: number;
		mobileLabelAnchor?: string;
	}

	interface Annotations {
		circles?: AnnCircle[];
		arrows?: AnnArrow[];
	}

	function quadraticBezier(from: number[], to: number[], curve: number): number[][] {
		const dx = to[0] - from[0];
		const dy = to[1] - from[1];
		const cx = (from[0] + to[0]) / 2 - dy * curve;
		const cy = (from[1] + to[1]) / 2 + dx * curve;
		const pts: number[][] = [];
		for (let i = 0; i <= 50; i++) {
			const t = i / 50;
			pts.push([
				(1 - t) * (1 - t) * from[0] + 2 * (1 - t) * t * cx + t * t * to[0],
				(1 - t) * (1 - t) * from[1] + 2 * (1 - t) * t * cy + t * t * to[1]
			]);
		}
		return pts;
	}

	function addArrowhead(pts: number[][]): number[][] {
		const last = pts[pts.length - 1];
		const prev = pts[pts.length - 3];
		const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
		const size = 0.15;
		return [
			[last[0] - size * Math.cos(angle - 0.4), last[1] - size * Math.sin(angle - 0.4)],
			last,
			[last[0] - size * Math.cos(angle + 0.4), last[1] - size * Math.sin(angle + 0.4)]
		];
	}

	function loadAnnotations(map: maplibregl.Map, ann: Annotations, narrow = false) {
		const ids: string[] = [];

		// Circles
		if (ann.circles?.length) {
			for (const c of ann.circles) {
				const color = isDark ? c.color : '#222222';
				const srcId = `ann-circle-${c.id}`;
				map.addSource(srcId, { type: 'geojson', data: {
					type: 'FeatureCollection',
					features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: c.coordinates as any }, properties: {} }]
				}});
				const fillId = `${srcId}-fill`;
				const lineId = `${srcId}-line`;
				map.addLayer({ id: fillId, type: 'fill', source: srcId, paint: { 'fill-color': color, 'fill-opacity': c.fillOpacity ?? 0.05 } });
				const linePaint: Record<string, any> = { 'line-color': color, 'line-width': c.width ?? 2, 'line-opacity': c.opacity ?? 0.7 };
				if (c.dasharray) linePaint['line-dasharray'] = c.dasharray;
				map.addLayer({ id: lineId, type: 'line', source: srcId, paint: linePaint });
				ids.push(fillId, lineId);
			}
		}

		// Arrows
		if (ann.arrows?.length) {
			const lineFeatures: GeoJSON.Feature[] = [];
			const arrowFeatures: GeoJSON.Feature[] = [];
			const labelFeatures: GeoJSON.Feature[] = [];

			for (const a of ann.arrows) {
				const color = isDark ? a.color : '#222222';
				const from = (narrow && a.mobileFrom) ? a.mobileFrom : a.from;
				const to = (narrow && a.mobileTo) ? a.mobileTo : a.to;
				const curve = (narrow && a.mobileCurve !== undefined) ? a.mobileCurve : a.curve;
				const pts = quadraticBezier(from, to, curve);
				lineFeatures.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: { color, width: a.width ?? 1.2, opacity: a.opacity ?? 0.5 } });
				arrowFeatures.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: addArrowhead(pts) }, properties: { color, opacity: a.opacity ?? 0.5 } });
				if (a.label) {
					const pos = a.labelPosition === 'end' ? pts[pts.length - 1] : a.labelPosition === 'middle' ? pts[Math.floor(pts.length / 2)] : pts[0];
					const anchor = (narrow && a.mobileLabelAnchor) ? a.mobileLabelAnchor : (a.labelAnchor ?? 'bottom');
					labelFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pos }, properties: { label: a.label, color, fontSize: a.fontSize ?? 13, anchor } });
				}
			}

			map.addSource('ann-arrows', { type: 'geojson', data: { type: 'FeatureCollection', features: lineFeatures } });
			map.addLayer({ id: 'ann-arrows-line', type: 'line', source: 'ann-arrows', paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] }, layout: { 'line-cap': 'round' } });
			ids.push('ann-arrows-line');

			map.addSource('ann-arrowheads', { type: 'geojson', data: { type: 'FeatureCollection', features: arrowFeatures } });
			map.addLayer({ id: 'ann-arrowheads-line', type: 'line', source: 'ann-arrowheads', paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': ['get', 'opacity'] }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
			ids.push('ann-arrowheads-line');

			if (labelFeatures.length) {
				map.addSource('ann-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: labelFeatures } });
				map.addLayer({ id: 'ann-labels-text', type: 'symbol', source: 'ann-labels', layout: { 'text-field': ['get', 'label'], 'text-size': ['get', 'fontSize'], 'text-font': POLICE_GRASSE, 'text-anchor': ['get', 'anchor'], 'text-offset': [0, 0], 'text-allow-overlap': true }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)', 'text-halo-width': 2 } });
				ids.push('ann-labels-text');
			}
		}

		annotationLayerIds = ids;
	}

	function updateMiniMapViewport() {
		if (!map || !miniMap) return;
		const bounds = map.getBounds();

		// Update the viewport rectangle on the mini map
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		const rectGeoJSON: GeoJSON.FeatureCollection = {
			type: 'FeatureCollection',
			features: [{
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: [[
						[sw.lng, sw.lat],
						[ne.lng, sw.lat],
						[ne.lng, ne.lat],
						[sw.lng, ne.lat],
						[sw.lng, sw.lat]
					]]
				},
				properties: {}
			}]
		};

		const src = miniMap.getSource('viewport') as maplibregl.GeoJSONSource;
		if (src) src.setData(rectGeoJSON);
	}

	onMount(() => {
		// Main map
		map = new maplibregl.Map({
			container: mapContainer,
			style: styleFond(isDark),
			maxBounds: [DATA_BOUNDS[0] - 5, DATA_BOUNDS[1] - 5, DATA_BOUNDS[2] + 5, DATA_BOUNDS[3] + 5],
			maxZoom: 14,
			minZoom: 2,
			cooperativeGestures: true,
			attributionControl: false
		});
		map.addControl(new maplibregl.AttributionControl({ customAttribution: ATTRIBUTION }), 'bottom-right');

		const isMobile = window.innerWidth <= 768;
		const bounds = initialBounds ?? DATA_BOUNDS;
		map.fitBounds(
			[[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
			{ padding: isMobile ? 10 : 40 }
		);

		map.addControl(new maplibregl.NavigationControl(), 'top-right');
		map.addControl(new maplibregl.ScaleControl({ maxWidth: 150, unit: 'metric' }), 'bottom-right');

		getCurrentBounds = () => {
			if (!map) return null;
			const b = map.getBounds();
			return [
				Math.round(b.getWest() * 1000) / 1000,
				Math.round(b.getSouth() * 1000) / 1000,
				Math.round(b.getEast() * 1000) / 1000,
				Math.round(b.getNorth() * 1000) / 1000
			];
		};

		// Persistently enforce compact attribution — MapLibre may strip the class on resize/style changes
		const attribEl = mapContainer.querySelector('.maplibregl-ctrl-attrib');
		if (attribEl) {
			attribEl.classList.add('maplibregl-compact');
			new MutationObserver(() => {
				if (!attribEl.classList.contains('maplibregl-compact')) {
					attribEl.classList.add('maplibregl-compact');
				}
			}).observe(attribEl, { attributes: true, attributeFilter: ['class'] });
		}

		map.on('load', () => {


			// Country labels
			map!.addSource('country-labels', {
				type: 'geojson',
				data: buildCountryLabelsGeoJSON()
			});


			map!.addLayer({
				id: 'country-labels-text',
				type: 'symbol',
				source: 'country-labels',
				layout: {
					'text-field': ['get', 'name'],
					'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 6, 14, 10, 18],
					'text-font': POLICE,
					'text-transform': 'uppercase',
					'text-letter-spacing': 0.15,
					'text-allow-overlap': false,
					'text-ignore-placement': false
				},
				paint: {
					'text-color': isDark ? '#777' : '#999',
					'text-halo-color': isDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)',
					'text-halo-width': 1.5
				}
			});

			// Country borders
			// Strike points
			const geojson = buildGeoJSON(selectedDate, visibleLayers);

			map!.addSource('strikes', {
				type: 'geojson',
				data: geojson
			});

			map!.addLayer({
				id: 'strikes-circle',
				type: 'circle',
				source: 'strikes',
				paint: {
					'circle-radius': [
						'interpolate', ['linear'], ['zoom'],
						3, 2.5,
						8, 5,
						14, 10
					],
					'circle-color': getColorExpression(data.meta.layers),
					'circle-opacity': 0.8,
					'circle-stroke-width': 0.5,
					'circle-stroke-color': '#000',
					'circle-stroke-opacity': 0.5
				}
			});

			// Highlight source (layer added after strikes so it renders on top)
			map!.addSource('highlight', {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] }
			});

			// Cursor on hover
			map!.on('mouseenter', 'strikes-circle', () => {
				if (map) map.getCanvas().style.cursor = 'pointer';
			});
			map!.on('mouseleave', 'strikes-circle', () => {
				if (map) map.getCanvas().style.cursor = '';
			});

			// Click popup
			map!.on('click', 'strikes-circle', (e) => {
				if (!map || !e.features?.length) return;
				const f = e.features[0];
				const props = f.properties;
				const layerMeta = data.meta.layers.find(l => l.id === props.layer);
				const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];

				const label = layerMeta ? t(layerMeta.label) : props.layer;
				const dateStr = new Date(props.date + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
				let html = `<div class="popup-layer" style="color:${layerMeta?.color || '#fff'}">${label}</div>`;
				const location = [props.city, props.province, t(props.country)].filter(Boolean).join(', ');
				if (location) html += `<div class="popup-city">${location}</div>`;
				html += `<div class="popup-date">${dateStr}</div>`;
				if (props.type) html += `<div class="popup-type"><strong>Type :</strong> ${t(props.type)}</div>`;
				if (props.siteType && t(props.siteType)) html += `<div class="popup-detail"><strong>Cible :</strong> ${t(props.siteType)}</div>`;
				if (props.actor && props.actor !== 'UNK') html += `<div class="popup-detail"><strong>Acteur :</strong> ${props.actor}</div>`;
				if (props.vessel) html += `<div class="popup-detail"><strong>Navire :</strong> ${props.vessel}${props.flag ? ` (${props.flag})` : ''}</div>`;
				if (props.source) html += `<a class="popup-source" href="${props.source}" target="_blank" rel="noopener">Source <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;

				// Remove old popup without clearing highlight
				if (popup) {
					popup.off('close', clearHighlight);
					popup.remove();
				}

				// Highlight clicked point
				(map!.getSource('highlight') as maplibregl.GeoJSONSource).setData({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: {} }]
				});

				popup = new maplibregl.Popup({
					closeButton: true,
					closeOnClick: false,
					offset: 10,
					className: 'strike-popup'
				}).setLngLat(coords).setHTML(html).addTo(map!);

				popup.on('close', clearHighlight);
			});

			// Close popup when clicking empty space
			map!.on('click', (e) => {
				const features = map!.queryRenderedFeatures(e.point, { layers: ['strikes-circle'] });
				if (!features.length && popup) {
					popup.remove();
				}
			});

			// Add highlight ring layer on top of everything
			map!.addLayer({
				id: 'highlight-ring',
				type: 'circle',
				source: 'highlight',
				paint: {
					'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 5, 8, 8, 14, 14],
					'circle-color': 'transparent',
					'circle-stroke-width': 2.5,
					'circle-stroke-color': isDark ? '#ffffff' : '#000000',
					'circle-stroke-opacity': 1
				}
			});

			// Load annotations
			fetch(`${import.meta.env.BASE_URL}data/annotations.json`)
				.then(r => r.json())
				.then((ann: Annotations) => { if (map) loadAnnotations(map, ann, mapContainer.clientWidth < 800); })
				.catch(() => {});
		});

		// Mini map (globe medallion)
		miniMap = new maplibregl.Map({
			container: miniMapContainer,
			style: styleFond(isDark, true),
			center: [47, 30],
			zoom: 0,
			interactive: false,
			attributionControl: false
		});

		miniMap.on('load', () => {
			// Viewport rectangle
			miniMap!.addSource('viewport', {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] }
			});

			miniMap!.addLayer({
				id: 'viewport-fill',
				type: 'fill',
				source: 'viewport',
				paint: {
					'fill-color': '#4a9eff',
					'fill-opacity': 0.15
				}
			});

			miniMap!.addLayer({
				id: 'viewport-line',
				type: 'line',
				source: 'viewport',
				paint: {
					'line-color': '#4a9eff',
					'line-width': 1.5
				}
			});

			updateMiniMapViewport();
		});

		// Sync mini map viewport on main map move
		map.on('move', updateMiniMapViewport);
	});

	// Close popup when user clicks outside the iframe (window loses focus)
	const onWindowBlur = () => { if (popup) { popup.remove(); popup = null; } };
	window.addEventListener('blur', onWindowBlur);

	onDestroy(() => {
		map?.remove();
		miniMap?.remove();
		unsub();
		window.removeEventListener('blur', onWindowBlur);
	});

	// React to theme changes
	$effect(() => {
		const dark = isDark;
		if (!map || !map.isStyleLoaded()) return;
		rhabillerFond(map, dark);
		// Country labels
		if (map.getLayer('country-labels-text')) {
			map.setPaintProperty('country-labels-text', 'text-color', dark ? '#777' : '#999');
			map.setPaintProperty('country-labels-text', 'text-halo-color', dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)');
		}
		// Highlight ring
		if (map.getLayer('highlight-ring')) {
			map.setPaintProperty('highlight-ring', 'circle-stroke-color', dark ? '#ffffff' : '#000000');
		}
		if (miniMap?.isStyleLoaded()) rhabillerFond(miniMap, dark, true);
	});

	$effect(() => {
		const date = selectedDate;
		const layers = visibleLayers;
		const _ = cumulative;
		if (!map?.getSource('strikes')) return;
		const geojson = buildGeoJSON(date, layers);
		(map.getSource('strikes') as maplibregl.GeoJSONSource).setData(geojson);
		if (popup) { popup.remove(); popup = null; }
	});

	$effect(() => {
		const _show = showAnnotations;
		const _cum = cumulative;
		if (!map || !annotationLayerIds.length) return;
		const visibility = (_show && _cum) ? 'visible' : 'none';
		for (const id of annotationLayerIds) {
			if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
		}
	});
</script>

<div bind:this={mapContainer} class="map"></div>
<div class="minimap-wrapper">
	<div bind:this={miniMapContainer} class="minimap"></div>
</div>

<style>
	.map {
		width: 100%;
		height: 100%;
		position: absolute;
		top: 0;
		left: 0;
	}

	.minimap-wrapper {
		position: absolute;
		bottom: 6px;
		left: 16px;
		width: 140px;
		height: 140px;
		border-radius: 50%;
		overflow: hidden;
		border: 2px solid var(--border);
		box-shadow: 0 4px 16px rgba(0,0,0,0.3);
		z-index: 10;
	}

	.minimap {
		width: 100%;
		height: 100%;
	}

	@media (max-width: 768px) {
		.minimap-wrapper {
			width: 90px;
			height: 90px;
			bottom: 6px;
			left: 10px;
		}
	}

	:global(.minimap-wrapper .maplibregl-canvas) {
		border-radius: 50%;
	}

:global(.strike-popup .maplibregl-popup-content) {
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 12px;
		font-family: 'Montserrat', sans-serif;
		font-size: 13px;
		line-height: 1.4;
		box-shadow: 0 4px 12px rgba(0,0,0,0.3);
	}

	:global(.strike-popup .maplibregl-popup-close-button) {
		color: var(--text-dim);
		font-size: 18px;
		padding: 2px 6px;
	}

	:global(.strike-popup .maplibregl-popup-close-button:hover) {
		color: var(--text);
		background: transparent;
	}

	:global(.strike-popup .maplibregl-popup-tip) {
		border-top-color: var(--surface);
	}

	:global(.popup-layer) {
		font-weight: 600;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 2px;
	}

	:global(.popup-city) {
		font-weight: 500;
	}

	:global(.popup-date) {
		color: var(--text-dim);
		font-size: 12px;
	}

	:global(.popup-type) {
		color: var(--text-dim);
		font-size: 11px;
		margin-top: 2px;
	}

	:global(.popup-detail) {
		color: var(--text-dim);
		font-size: 11px;
	}

	:global(.popup-source) {
		display: inline-block;
		color: var(--accent);
		font-size: 11px;
		margin-top: 3px;
		text-decoration: none;
	}

	:global(.popup-source:hover) {
		text-decoration: underline;
	}
</style>
