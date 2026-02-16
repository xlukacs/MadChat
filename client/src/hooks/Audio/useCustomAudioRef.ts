import { useEffect, useRef } from 'react';

interface CustomAudioElement extends HTMLAudioElement {
  customStarted?: boolean;
  customEnded?: boolean;
  customPaused?: boolean;
  customProps?: {
    customStarted?: boolean;
    customEnded?: boolean;
    customPaused?: boolean;
  };
}

type TCustomAudioResult = { audioRef: React.MutableRefObject<CustomAudioElement | null> };

export default function useCustomAudioRef({
  setIsPlaying,
  onEnded,
}: {
  setIsPlaying: (isPlaying: boolean) => void;
  onEnded?: () => void;
}): TCustomAudioResult {
  const audioRef = useRef<CustomAudioElement | null>(null);
  const hasProcessedEnd = useRef(false);
  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    let lastTimeUpdate: number | null = null;
    let sameTimeUpdateCount = 0;

    const handleEnded = () => {
      if (hasProcessedEnd.current) {
        return;
      }
      hasProcessedEnd.current = true;
      setIsPlaying(false);
      console.log('global audio ended');
      onEnded?.();
      if (audioRef.current) {
        audioRef.current.customEnded = true;
        URL.revokeObjectURL(audioRef.current.src);
      }
    };

    const handleStart = () => {
      hasProcessedEnd.current = false;
      setIsPlaying(true);
      if (audioRef.current) {
        audioRef.current.muted = false;
        audioRef.current.customStarted = true;
      }
    };

    const handlePause = () => {
      setIsPlaying(false);
      console.log('global audio paused');
      if (audioRef.current) {
        audioRef.current.customPaused = true;
      }
    };

    const handleTimeUpdate = () => {
      if (audioRef.current) {
        const currentTime = audioRef.current.currentTime;
        // console.log('Current time: ', currentTime);

        if (currentTime === lastTimeUpdate) {
          sameTimeUpdateCount += 1;
        } else {
          sameTimeUpdateCount = 0;
        }

        lastTimeUpdate = currentTime;

        if (sameTimeUpdateCount >= 1) {
          console.log('Detected end of audio based on time update');
          audioRef.current.pause();
          handleEnded();
        }
      }
    };

    audioElement.addEventListener('ended', handleEnded);
    audioElement.addEventListener('play', handleStart);
    audioElement.addEventListener('pause', handlePause);
    audioElement.addEventListener('timeupdate', handleTimeUpdate);

    audioElement.customProps = {
      customStarted: false,
      customEnded: false,
      customPaused: false,
    };

    return () => {
      audioElement.removeEventListener('ended', handleEnded);
      audioElement.removeEventListener('play', handleStart);
      audioElement.removeEventListener('pause', handlePause);
      audioElement.removeEventListener('timeupdate', handleTimeUpdate);
      URL.revokeObjectURL(audioElement.src);
    };
  }, [onEnded, setIsPlaying]);

  return { audioRef };
}
