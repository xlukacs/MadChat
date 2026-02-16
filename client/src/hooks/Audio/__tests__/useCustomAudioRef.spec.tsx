import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import useCustomAudioRef from '../useCustomAudioRef';

function TestHarness({
  setIsPlaying,
  onEnded,
}: {
  setIsPlaying: (isPlaying: boolean) => void;
  onEnded: () => void;
}) {
  const { audioRef } = useCustomAudioRef({ setIsPlaying, onEnded });
  return <audio ref={audioRef} data-testid="voice-audio" />;
}

describe('useCustomAudioRef', () => {
  beforeEach(() => {
    URL.revokeObjectURL = jest.fn();
  });

  test('calls onEnded once per playback cycle', () => {
    const setIsPlaying = jest.fn();
    const onEnded = jest.fn();
    render(<TestHarness setIsPlaying={setIsPlaying} onEnded={onEnded} />);

    const audio = screen.getByTestId('voice-audio');

    fireEvent(audio, new Event('play'));
    fireEvent(audio, new Event('pause'));
    fireEvent(audio, new Event('ended'));
    fireEvent(audio, new Event('ended'));

    expect(setIsPlaying).toHaveBeenCalledWith(true);
    expect(setIsPlaying).toHaveBeenCalledWith(false);
    expect(onEnded).toHaveBeenCalledTimes(1);

    fireEvent(audio, new Event('play'));
    fireEvent(audio, new Event('ended'));

    expect(onEnded).toHaveBeenCalledTimes(2);
  });
});
