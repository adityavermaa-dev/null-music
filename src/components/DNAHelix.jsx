import React, { useEffect, useRef } from 'react';

/**
 * DNAHelix Component
 * Renders an animated DNA helix SVG based on user's music DNA
 */
export function DNAHelix({ dna }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !dna) return;
    drawDNAHelix(svgRef.current, dna);
  }, [dna]);

  return (
    <div className="dna-helix">
      <svg
        ref={svgRef}
        width="300"
        height="400"
        viewBox="0 0 300 400"
        className="helix-svg"
      />
    </div>
  );
}

/**
 * Draw animated DNA helix with user's music profile
 */
function drawDNAHelix(svgElement, dna) {
  const svg = svgElement;
  svg.innerHTML = ''; // Clear previous content

  const width = 300;
  const height = 400;
  const centerX = width / 2;
  const amplitude = 40;
  const spirals = 3;
  const pointCount = 200;

  // Create defs for gradients and animations
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

  // Gradient based on energy level
  const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  gradient.setAttribute('id', 'helixGradient');
  gradient.setAttribute('x1', '0%');
  gradient.setAttribute('y1', '0%');
  gradient.setAttribute('x2', '100%');
  gradient.setAttribute('y2', '0%');

  const color1 = getColorFromEnergy(dna.energyAverage || 0.5);
  const color2 = getColorFromValence(dna.valenceAverage || 0.5);

  const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', color1);

  const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', color2);

  gradient.appendChild(stop1);
  gradient.appendChild(stop2);
  defs.appendChild(gradient);

  // Animation
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    @keyframes rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .dna-group {
      transform-origin: ${centerX}px ${height / 2}px;
      animation: rotate 20s linear infinite;
    }
  `;
  defs.appendChild(style);
  svg.appendChild(defs);

  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('class', 'dna-group');

  // Draw the two strands
  const points = generateHelixPoints(height, centerX, amplitude, spirals, pointCount);

  // Strand 1
  const strand1 = createStrand(points.strand1, 'url(#helixGradient)', 3);
  group.appendChild(strand1);

  // Strand 2 (offset by 180 degrees)
  const strand2 = createStrand(points.strand2, color1, 3, 0.5);
  group.appendChild(strand2);

  // Draw connecting bridges
  for (let i = 0; i < pointCount; i += 10) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', points.strand1[i].x);
    line.setAttribute('y1', points.strand1[i].y);
    line.setAttribute('x2', points.strand2[i].x);
    line.setAttribute('y2', points.strand2[i].y);
    line.setAttribute('stroke', color2);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('opacity', '0.4');
    group.appendChild(line);
  }

  // Add info nodes along the helix
  const danceability = dna.danceabilityAverage || 0.5;
  const acousticness = dna.acousticnessAverage || 0.3;

  for (let i = 0; i < pointCount; i += Math.floor(pointCount / 6)) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', points.strand1[i].x);
    circle.setAttribute('cy', points.strand1[i].y);
    circle.setAttribute('r', '2');
    circle.setAttribute('fill', color1);
    circle.setAttribute('opacity', '0.7');
    group.appendChild(circle);
  }

  svg.appendChild(group);

  // Add labels
  const energyLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  energyLabel.setAttribute('x', '10');
  energyLabel.setAttribute('y', '25');
  energyLabel.setAttribute('fill', color1);
  energyLabel.setAttribute('font-size', '12');
  energyLabel.setAttribute('font-weight', 'bold');
  energyLabel.textContent = `Energy: ${Math.round((dna.energyAverage || 0.5) * 100)}%`;
  svg.appendChild(energyLabel);

  const vibe = getVibeDescription(dna);
  const vibeLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  vibeLabel.setAttribute('x', '10');
  vibeLabel.setAttribute('y', '385');
  vibeLabel.setAttribute('fill', '#999');
  vibeLabel.setAttribute('font-size', '11');
  vibeLabel.textContent = vibe;
  svg.appendChild(vibeLabel);
}

/**
 * Generate helix points for rendering
 */
function generateHelixPoints(height, centerX, amplitude, spirals, pointCount) {
  const strand1 = [];
  const strand2 = [];

  for (let i = 0; i < pointCount; i++) {
    const t = i / pointCount;
    const y = t * height;
    const angle = t * Math.PI * 2 * spirals;

    // Strand 1
    strand1.push({
      x: centerX + Math.cos(angle) * amplitude,
      y: y,
    });

    // Strand 2 (opposite side)
    strand2.push({
      x: centerX + Math.cos(angle + Math.PI) * amplitude,
      y: y,
    });
  }

  return { strand1, strand2 };
}

/**
 * Create SVG path for a strand
 */
function createStrand(points, stroke, strokeWidth = 2, opacity = 1) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  
  path.setAttribute('d', d);
  path.setAttribute('stroke', stroke);
  path.setAttribute('stroke-width', strokeWidth);
  path.setAttribute('fill', 'none');
  path.setAttribute('opacity', opacity);
  
  return path;
}

/**
 * Get color based on energy level
 */
function getColorFromEnergy(energy) {
  if (energy > 0.7) return '#FF6B6B'; // Red - High energy
  if (energy > 0.5) return '#FFA500'; // Orange - Medium-high
  if (energy > 0.3) return '#4ECDC4'; // Teal - Medium-low
  return '#95E1D3'; // Light teal - Low energy
}

/**
 * Get color based on valence (mood)
 */
function getColorFromValence(valence) {
  if (valence > 0.7) return '#FFD93D'; // Yellow - Happy
  if (valence > 0.5) return '#6BCB77'; // Green - Positive
  if (valence > 0.3) return '#4D96FF'; // Blue - Neutral
  return '#A8A8A8'; // Gray - Sad
}

/**
 * Get vibe description
 */
function getVibeDescription(dna) {
  const energy = dna.energyAverage || 0.5;
  const valence = dna.valenceAverage || 0.5;
  const danceability = dna.danceabilityAverage || 0.5;

  if (energy > 0.7 && valence > 0.6) {
    return '🔥 High-energy, feel-good vibes';
  } else if (energy > 0.7 && valence < 0.4) {
    return '⚡ Intense, moody energy';
  } else if (energy < 0.3 && valence > 0.6) {
    return '🌸 Calm, positive atmosphere';
  } else if (energy < 0.3 && valence < 0.4) {
    return '🌙 Mellow, introspective mood';
  } else if (danceability > 0.7) {
    return '🎵 Groovy, danceable beats';
  } else {
    return '🎶 Balanced, versatile taste';
  }
}
