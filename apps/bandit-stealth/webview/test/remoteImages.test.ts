/**
 * Click-to-load: nothing is requested until the user clicks the span; the
 * host's reply replaces it with a data: image, and only data:image/ URIs are
 * ever inserted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLoadedImages,
  handleRemoteImageResult,
  installRemoteImageLoader,
  resetRemoteImagesForTests
} from '../src/util/remoteImages';

const SPAN = '<span class="bandit-blocked-image" role="button" tabindex="0" data-remote-image-src="https://img.example/a.png">[image] chart: https://img.example/a.png (click to load from img.example)</span>';
let posted: Array<{ type: string; url: string }> = [];
let uninstall: () => void = () => undefined;

beforeEach(() => {
  resetRemoteImagesForTests();
  posted = [];
  document.body.innerHTML = `<div id="m">${SPAN}</div>`;
  uninstall = installRemoteImageLoader((msg) => posted.push(msg));
});
afterEach(() => uninstall());

describe('remote image click-to-load', () => {
  it('requests nothing until clicked, then asks the host for that URL once', () => {
    expect(posted).toEqual([]);
    const span = document.querySelector<HTMLElement>('[data-remote-image-src]')!;
    span.click();
    span.click();
    expect(posted).toEqual([{ type: 'loadRemoteImage', url: 'https://img.example/a.png' }]);
    expect(span.dataset.state).toBe('loading');
  });

  it('replaces the span with the data: image, and again after a re-render', () => {
    document.querySelector<HTMLElement>('[data-remote-image-src]')!.click();
    handleRemoteImageResult({ type: 'remoteImageLoaded', url: 'https://img.example/a.png', dataUri: 'data:image/png;base64,AAAA' });
    let img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    document.getElementById('m')!.innerHTML = SPAN; // markdown re-render
    applyLoadedImages();
    img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('never inserts a non-data URI', () => {
    document.querySelector<HTMLElement>('[data-remote-image-src]')!.click();
    handleRemoteImageResult({ type: 'remoteImageLoaded', url: 'https://img.example/a.png', dataUri: 'https://img.example/a.png' });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-remote-image-src]')!.dataset.state).toBe('failed');
  });
});
