import { memo, useState, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Download, ExternalLink } from 'lucide-react';
import { imageExtRegex, Tools } from 'librechat-data-provider';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import Image from '~/components/Chat/Messages/Content/Image';
import { useAttachmentLink } from './LogLink';
import { useFileDownload } from '~/data-provider';
import { cn } from '~/utils';
import store from '~/store';

const FileAttachment = memo(({ attachment }: { attachment: Partial<TAttachment> }) => {
  const [isVisible, setIsVisible] = useState(false);
  const user = useRecoilValue(store.user);
  const hasStoredFileId = typeof (attachment as any).file_id === 'string' && (attachment as any).file_id.length > 0;
  const fileId = hasStoredFileId ? ((attachment as any).file_id as string) : '';
  const filename = attachment.filename ?? '';
  const filepath = attachment.filepath ?? '';
 
  const { refetch: downloadStoredFile } = useFileDownload(user?.id ?? '', fileId);
  const { handleDownload: handleCodeOutputDownload } = useAttachmentLink({
    href: filepath,
    filename,
  });
  const extension = attachment.filename?.split('.').pop();

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  if (!filepath) {
    return null;
  }
 
  const getObjectUrl = async (): Promise<string | null> => {
    if (hasStoredFileId) {
      const stream = await downloadStoredFile();
      return typeof stream.data === 'string' && stream.data.length > 0 ? stream.data : null;
    }
    return null;
  };
 
  const handleDownload = async (e: React.MouseEvent<HTMLButtonElement>) => {
    // For stored files (DB), download via /api/files/download/:user/:file_id
    if (hasStoredFileId) {
      e.preventDefault();
      e.stopPropagation();
      const url = await getObjectUrl();
      if (!url) {
        return;
      }
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename || 'file');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      return;
    }
    // Fallback for code outputs (already returns a blob URL internally)
    return handleCodeOutputDownload(e);
  };
 
  const handleOpen = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (hasStoredFileId) {
      const url = await getObjectUrl();
      if (!url) {
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      // Intentionally do NOT revoke immediately; new tab needs it.
      return;
    }
    // For non-stored outputs, best-effort open original href
    window.open(filepath, '_blank', 'noopener,noreferrer');
  };
 
  return (
    <div
      className={cn(
        'file-attachment-container',
        'transition-all duration-300 ease-out',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
      style={{
        transformOrigin: 'center top',
        willChange: 'opacity, transform',
        WebkitFontSmoothing: 'subpixel-antialiased',
      }}
    >
      <div className="group relative max-w-fit">
        <FileContainer
          file={attachment}
          onClick={handleDownload}
          overrideType={extension}
          containerClassName="max-w-fit"
          buttonClassName="bg-surface-secondary hover:cursor-pointer hover:bg-surface-hover active:bg-surface-secondary focus:bg-surface-hover hover:border-border-heavy active:border-border-heavy"
        />
        <div className="pointer-events-none absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={handleOpen}
            className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-light bg-surface-primary text-text-secondary shadow-sm hover:bg-surface-hover"
            aria-label="Open file"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-light bg-surface-primary text-text-secondary shadow-sm hover:bg-surface-hover"
            aria-label="Download file"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
});

const ImageAttachment = memo(({ attachment }: { attachment: TAttachment }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const { width, height, filepath = null } = attachment as TFile & TAttachmentMetadata;

  useEffect(() => {
    setIsLoaded(false);
    const timer = setTimeout(() => setIsLoaded(true), 100);
    return () => clearTimeout(timer);
  }, [attachment]);

  return (
    <div
      className={cn(
        'image-attachment-container',
        'transition-all duration-500 ease-out',
        isLoaded ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0',
      )}
      style={{
        transformOrigin: 'center top',
        willChange: 'opacity, transform',
        WebkitFontSmoothing: 'subpixel-antialiased',
      }}
    >
      <Image
        altText={attachment.filename || 'attachment image'}
        imagePath={filepath ?? ''}
        height={height ?? 0}
        width={width ?? 0}
        className="mb-4"
      />
    </div>
  );
});

export default function Attachment({ attachment }: { attachment?: TAttachment }) {
  if (!attachment) {
    return null;
  }
  if (attachment.type === Tools.web_search) {
    return null;
  }

  const { width, height, filepath = null } = attachment as TFile & TAttachmentMetadata;
  const isImage = attachment.filename
    ? imageExtRegex.test(attachment.filename) && width != null && height != null && filepath != null
    : false;

  if (isImage) {
    return <ImageAttachment attachment={attachment} />;
  } else if (!attachment.filepath) {
    return null;
  }
  return <FileAttachment attachment={attachment} />;
}

export function AttachmentGroup({ attachments }: { attachments?: TAttachment[] }) {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const fileAttachments: TAttachment[] = [];
  const imageAttachments: TAttachment[] = [];

  attachments.forEach((attachment) => {
    const { width, height, filepath = null } = attachment as TFile & TAttachmentMetadata;
    const isImage = attachment.filename
      ? imageExtRegex.test(attachment.filename) &&
        width != null &&
        height != null &&
        filepath != null
      : false;

    if (isImage) {
      imageAttachments.push(attachment);
    } else if (attachment.type !== Tools.web_search) {
      fileAttachments.push(attachment);
    }
  });

  return (
    <>
      {fileAttachments.length > 0 && (
        <div className="my-2 flex flex-wrap items-center gap-2.5">
          {fileAttachments.map((attachment, index) =>
            attachment.filepath ? (
              <FileAttachment attachment={attachment} key={`file-${index}`} />
            ) : null,
          )}
        </div>
      )}
      {imageAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center">
          {imageAttachments.map((attachment, index) => (
            <ImageAttachment attachment={attachment} key={`image-${index}`} />
          ))}
        </div>
      )}
    </>
  );
}
