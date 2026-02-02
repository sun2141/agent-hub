import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import './PrayerAmbience.css';

/**
 * Breathing animation and color changes based on emotional context
 * Creates an immersive atmosphere during prayer generation
 */
export function PrayerAmbience({ isActive, emotion = 'peace' }) {
  // Emotion-based color palettes
  const emotionColors = useMemo(() => ({
    peace: {
      primary: 'rgba(147, 197, 253, 0.3)',   // Soft blue
      secondary: 'rgba(196, 181, 253, 0.2)'  // Light purple
    },
    gratitude: {
      primary: 'rgba(251, 191, 36, 0.3)',    // Warm orange
      secondary: 'rgba(252, 211, 77, 0.2)'   // Light yellow
    },
    sadness: {
      primary: 'rgba(147, 197, 253, 0.3)',   // Deeper blue
      secondary: 'rgba(165, 180, 252, 0.2)'  // Soft indigo
    },
    hope: {
      primary: 'rgba(134, 239, 172, 0.3)',   // Soft green
      secondary: 'rgba(167, 243, 208, 0.2)'  // Light teal
    },
    default: {
      primary: 'rgba(203, 213, 225, 0.3)',   // Neutral gray-blue
      secondary: 'rgba(226, 232, 240, 0.2)'  // Light gray
    }
  }), []);

  const colors = emotionColors[emotion] || emotionColors.default;

  // Breathing animation configuration (3-4 second cycle)
  const breathingVariants = {
    initial: {
      scale: 1,
      opacity: 0.5
    },
    breathe: {
      scale: [1, 1.3, 1],
      opacity: [0.5, 0.8, 0.5],
      transition: {
        duration: 3.5,
        repeat: Infinity,
        ease: "easeInOut"
      }
    }
  };

  if (!isActive) {
    return null;
  }

  return (
    <div className="prayer-ambience">
      {/* Primary breathing circle */}
      <motion.div
        className="ambience-circle primary"
        variants={breathingVariants}
        initial="initial"
        animate="breathe"
        style={{
          background: `radial-gradient(circle, ${colors.primary} 0%, transparent 70%)`
        }}
      />

      {/* Secondary breathing circle with slight delay */}
      <motion.div
        className="ambience-circle secondary"
        variants={breathingVariants}
        initial="initial"
        animate="breathe"
        transition={{
          duration: 3.5,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.5
        }}
        style={{
          background: `radial-gradient(circle, ${colors.secondary} 0%, transparent 70%)`
        }}
      />

      {/* Subtle particles for depth */}
      <div className="ambience-particles">
        {[...Array(12)].map((_, i) => (
          <motion.div
            key={i}
            className="particle"
            initial={{
              x: Math.random() * 100 - 50,
              y: Math.random() * 100 - 50,
              opacity: 0
            }}
            animate={{
              x: [
                Math.random() * 100 - 50,
                Math.random() * 150 - 75,
                Math.random() * 100 - 50
              ],
              y: [
                Math.random() * 100 - 50,
                Math.random() * 150 - 75,
                Math.random() * 100 - 50
              ],
              opacity: [0, 0.6, 0]
            }}
            transition={{
              duration: 4 + Math.random() * 2,
              repeat: Infinity,
              delay: Math.random() * 2,
              ease: "easeInOut"
            }}
            style={{
              background: colors.primary
            }}
          />
        ))}
      </div>
    </div>
  );
}
