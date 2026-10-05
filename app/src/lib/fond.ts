import type maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';

export const POLICE = ['Noto Sans Regular'];
export const POLICE_GRASSE = ['Noto Sans Bold'];

export const ATTRIBUTION =
	'MapLibre | &copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

function couleurs(dark: boolean, medaillon: boolean) {
	return {
		fond: dark ? '#0e0e0e' : '#FAFAF8',
		eau: dark ? '#262626' : '#D4DADC',
		frontiere: dark ? '#ffffff' : '#000000',
		opacite: medaillon ? (dark ? 0.3 : 0.25) : dark ? 0.5 : 0.6
	};
}

export function styleFond(dark: boolean, medaillon = false): StyleSpecification {
	const c = couleurs(dark, medaillon);
	return {
		version: 8,
		glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
		sources: {
			openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' }
		},
		layers: [
			{ id: 'background', type: 'background', paint: { 'background-color': c.fond } },
			{
				id: 'water',
				type: 'fill',
				source: 'openmaptiles',
				'source-layer': 'water',
				filter: ['==', '$type', 'Polygon'],
				paint: { 'fill-color': c.eau }
			},
			{
				id: 'boundary_state',
				type: 'line',
				source: 'openmaptiles',
				'source-layer': 'boundary',
				filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-blur': 0.4,
					'line-color': c.frontiere,
					'line-opacity': c.opacite,
					'line-width': medaillon
						? 0.6
						: ['interpolate', ['exponential', 1.3], ['zoom'], 3, 1, 22, 15]
				}
			}
		]
	};
}

export function rhabillerFond(map: maplibregl.Map, dark: boolean, medaillon = false) {
	const c = couleurs(dark, medaillon);
	if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', c.fond);
	if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', c.eau);
	if (map.getLayer('boundary_state')) {
		map.setPaintProperty('boundary_state', 'line-color', c.frontiere);
		map.setPaintProperty('boundary_state', 'line-opacity', c.opacite);
	}
}
