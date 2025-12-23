import React, { useState, useRef, useEffect } from 'react';
import { Header } from '../components/common/Header';
import { useAuth } from '../context/AuthContext';
import type { Page } from '../App';
import { UploadCloud, Trash2, Save, Image, AlertTriangle } from 'lucide-react';

interface BrandingPageProps {
    onNavigate: (page: Page) => void;
    onLogout: () => void;
    onUpdateBranding: (logoBase64: string | null) => void;
}

const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = error => reject(error);
    });
};

export const BrandingPage: React.FC<BrandingPageProps> = ({ onNavigate, onLogout, onUpdateBranding }) => {
    const { currentUser, currentOrganization } = useAuth();
    const [logoPreview, setLogoPreview] = useState<string | null>(null);
    const [error, setError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setLogoPreview(currentOrganization?.customLogoBase64 || null);
    }, [currentOrganization]);
    
    if (currentUser?.role !== 'admin') {
        // Simple guard for non-admins
        return (
            <div className="min-h-screen bg-slate-100">
                <Header pageTitle="Access Denied" onNavigate={onNavigate} onLogout={onLogout} />
                <main className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
                     <div className="bg-white rounded-xl shadow-md p-8 text-center">
                        <AlertTriangle className="mx-auto h-12 w-12 text-red-500"/>
                        <h2 className="mt-4 text-2xl font-bold text-slate-900">Access Denied</h2>
                        <p className="mt-2 text-slate-600">You do not have permission to view this page.</p>
                     </div>
                </main>
            </div>
        );
    }

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (file.size > 2 * 1024 * 1024) { // 2MB limit
            setError('File size must be less than 2MB.');
            return;
        }

        if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(file.type)) {
            setError('Please upload a PNG, JPG, or SVG file.');
            return;
        }

        setError('');
        try {
            const base64 = await fileToBase64(file);
            setLogoPreview(base64);
        } catch (err) {
            setError('Failed to read the file.');
        }
    };
    
    const handleRemoveLogo = () => {
        setLogoPreview(null);
    };

    const handleSave = () => {
        onUpdateBranding(logoPreview);
        alert("Branding updated successfully!");
    };
    
    return (
        <div className="min-h-screen bg-slate-100">
            <Header pageTitle="Branding Settings" onNavigate={onNavigate} onLogout={onLogout} />
            <main className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
                 <div className="bg-white rounded-xl shadow-md p-6 max-w-2xl mx-auto">
                    <h2 className="text-2xl font-bold text-slate-900 mb-2">Customize Your Workspace</h2>
                    <p className="text-slate-600 mb-6">Upload your company logo to be displayed in the application header. This logo will be visible to all users in your organization.</p>
                    
                    {error && <p className="text-sm text-red-600 bg-red-50 p-3 rounded-md mb-4">{error}</p>}
                    
                    <div className="p-4 bg-slate-50 border rounded-lg">
                        <label className="text-sm font-semibold text-slate-700">Company Logo</label>
                        <p className="text-xs text-slate-500 mt-1">
                            Recommended: PNG with transparent background. Max height: 48px. Max file size: 2MB.
                        </p>
                        <div className="mt-2 w-full h-48 border-2 border-dashed border-slate-300 rounded-lg flex justify-center items-center">
                            {logoPreview ? (
                                <img src={logoPreview} alt="Logo Preview" className="max-h-36 max-w-full object-contain" />
                            ) : (
                                <div className="text-center text-slate-500">
                                    <Image size={40} className="mx-auto" />
                                    <p>No logo uploaded</p>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="mt-4 flex flex-col sm:flex-row gap-4">
                        <button onClick={() => fileInputRef.current?.click()} className="flex-1 flex justify-center items-center gap-2 px-4 py-2 bg-white text-slate-700 font-semibold text-sm rounded-lg border border-slate-300 hover:bg-slate-100">
                            <UploadCloud size={16} /> Upload New Logo
                        </button>
                        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/png, image/jpeg, image/svg+xml" className="hidden" />
                        
                        <button onClick={handleRemoveLogo} disabled={!logoPreview} className="flex-1 flex justify-center items-center gap-2 px-4 py-2 bg-white text-red-600 font-semibold text-sm rounded-lg border border-slate-300 hover:bg-red-50 disabled:opacity-50 disabled:text-slate-500 disabled:hover:bg-white">
                            <Trash2 size={16} /> Remove Logo
                        </button>
                    </div>

                    <div className="mt-8 pt-6 border-t flex justify-end">
                         <button onClick={handleSave} className="flex items-center gap-2 px-6 py-3 bg-[#003580] text-white font-bold rounded-lg hover:bg-[#002a66]">
                            <Save size={18} /> Save Changes
                        </button>
                    </div>
                 </div>
            </main>
        </div>
    );
};