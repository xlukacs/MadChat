import { useCallback, useState } from 'react';
import { useRecoilValue } from 'recoil';
import JSZip from 'jszip';
import type { TFile } from 'librechat-data-provider';
import { dataService } from 'librechat-data-provider';
import store from '~/store';
import { useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';

export default function useBulkDownload() {
  const user = useRecoilValue(store.user);
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadFilesAsZip = useCallback(
    async (files: TFile[]) => {
      if (!files.length) {
        showToast({
          status: 'error',
          message: localize('com_files_no_files_selected'),
        });
        return;
      }

      if (!user?.id) {
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
        return;
      }

      setIsDownloading(true);

      try {
        // If only one file, download it directly without zipping
        if (files.length === 1) {
          const file = files[0];
          if (!file.file_id) {
            showToast({
              status: 'error',
              message: localize('com_ui_download_error'),
            });
            return;
          }

          try {
            const response = await dataService.getFileDownload(user.id, file.file_id);
            const blob = response.data;
            
            // Create download link for single file
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = file.filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);

            showToast({
              status: 'success',
              message: localize('com_files_download_success', {
                0: '1',
              }),
            });
          } catch (error) {
            console.error(`Error downloading file ${file.filename}:`, error);
            showToast({
              status: 'error',
              message: localize('com_ui_download_error'),
            });
          }
          return;
        }

        // Multiple files - create zip
        const zip = new JSZip();
        const filenameCounts = new Map<string, number>();
        
        const downloadResults = await Promise.allSettled(
          files.map(async (file) => {
            if (!file.file_id) {
              console.warn(`File ${file.filename} has no file_id, skipping`);
              return { success: false, filename: file.filename };
            }

            try {
              const response = await dataService.getFileDownload(user.id, file.file_id);
              const blob = response.data;
              
              // Handle duplicate filenames by adding a number suffix
              let zipFilename = file.filename;
              const count = filenameCounts.get(file.filename) || 0;
              if (count > 0) {
                const extIndex = file.filename.lastIndexOf('.');
                if (extIndex > 0) {
                  const name = file.filename.substring(0, extIndex);
                  const ext = file.filename.substring(extIndex);
                  zipFilename = `${name}_${count}${ext}`;
                } else {
                  zipFilename = `${file.filename}_${count}`;
                }
              }
              filenameCounts.set(file.filename, count + 1);
              
              // Add file to zip with its filename (possibly modified for duplicates)
              zip.file(zipFilename, blob);
              return { success: true, filename: file.filename };
            } catch (error) {
              console.error(`Error downloading file ${file.filename}:`, error);
              return { success: false, filename: file.filename };
            }
          }),
        );

        const successful = downloadResults.filter((r) => r.status === 'fulfilled' && r.value.success).length;
        const failed = downloadResults.length - successful;

        if (successful === 0) {
          showToast({
            status: 'error',
            message: localize('com_ui_download_error'),
          });
          return;
        }

        // Generate zip file
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        
        // Create download link
        const url = window.URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `files-${new Date().toISOString().split('T')[0]}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);

        const successMessage =
          failed > 0
            ? localize('com_files_download_success', {
                0: `${successful}`,
              }) + ` (${failed} failed)`
            : localize('com_files_download_success', {
                0: `${successful}`,
              });

        showToast({
          status: failed > 0 ? 'warning' : 'success',
          message: successMessage,
        });
      } catch (error) {
        console.error('Error creating zip file:', error);
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
      } finally {
        setIsDownloading(false);
      }
    },
    [user?.id, localize, showToast],
  );

  return { downloadFilesAsZip, isDownloading };
}

