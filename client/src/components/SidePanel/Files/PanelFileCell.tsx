import type { Row } from '@tanstack/react-table';
import type { TFile } from 'librechat-data-provider';
import { TooltipAnchor } from '@librechat/client';
import ImagePreview from '~/components/Chat/Input/Files/ImagePreview';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { getFileType } from '~/utils';

export default function PanelFileCell({ row }: { row: Row<TFile | undefined> }) {
  const file = row.original;
  return (
    <div className="flex w-full items-center gap-2 min-w-0">
      {file?.type?.startsWith('image') === true ? (
        <ImagePreview
          url={file.filepath}
          className="h-8 w-8 flex-shrink-0"
          source={file.source}
          alt={file.filename}
        />
      ) : (
        <div className="h-8 w-8 flex-shrink-0">
          <FilePreview fileType={getFileType(file?.type)} file={file} />
        </div>
      )}
      <TooltipAnchor
        description={file?.filename ?? ''}
        side="top"
        className="min-w-0 flex-1 overflow-hidden"
      >
        <span className="block w-full truncate text-xs" title={file?.filename}>
          {file?.filename}
        </span>
      </TooltipAnchor>
    </div>
  );
}
