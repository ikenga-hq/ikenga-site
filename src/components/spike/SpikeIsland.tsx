import { useState } from 'react';

/** WP-06 spike: proves @astrojs/react hydrates an island on Astro 7. */
export default function SpikeIsland({ label = 'Island' }: { label?: string }) {
	const [n, setN] = useState(0);
	return (
		<button
			type="button"
			data-spike-island
			data-hydrated={n >= 0 ? 'true' : 'false'}
			onClick={() => setN((v) => v + 1)}
		>
			{label}: clicked {n} times
		</button>
	);
}
